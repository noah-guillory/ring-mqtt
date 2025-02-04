import { Worker } from 'worker_threads'

export class LiveStream {
    constructor(device) {
        this.mqttCamera = device
        this.session = false
        this.status = 'inactive'

        this.worker = new Worker('./devices/stream/worker.js', {
            workerData: {
                doorbotId: this.mqttCamera.device.id,
                deviceName: this.mqttCamera.deviceData.name
            }
        })

        this.worker.on('message', (message) => {
            if (message.type === 'state') {
                switch (message.data) {
                    case 'active':
                        this.status = 'active'
                        this.session = true
                        break
                    case 'inactive':
                        this.status = 'inactive'
                        this.session = false
                        break
                    case 'failed':
                        this.status = 'failed'
                        this.session = false
                        break
                }
                this.mqttCamera.publishStreamState()
            } else {
                switch (message.type) {
                    case 'log_info':
                        this.mqttCamera.debug(message.data, 'wrtc')
                        break
                    case 'log_error':
                        this.mqttCamera.debug(message.data, 'wrtc-error')
                        break
                }
            }
        })
    }

    async start(rtspPublishUrl) {
        this.session = true

        const streamData = {
            rtspPublishUrl,
            ticket: null
        }

        try {
            this.mqttCamera.debug('Acquiring a live stream WebRTC signaling session ticket')
            const response = await this.mqttCamera.device.restClient.request({
                method: 'POST',
                url: 'https://app.ring.com/api/v1/clap/ticket/request/signalsocket'
            })
            streamData.ticket = response.ticket
        } catch(error) {
            if (error?.response?.statusCode === 403) {
                this.mqttCamera.debug('Camera returned 403 when starting a live stream. This usually indicates that live streaming is blocked by Modes settings.')
            } else {
                this.mqttCamera.debug(error)
            }
        }

        if (streamData.ticket) {
            this.mqttCamera.debug('Live stream WebRTC signaling session ticket acquired, starting live stream worker')
            this.worker.postMessage({ command: 'start', streamData })
        } else {
            this.mqttCamera.debug('Live stream failed to initialize WebRTC signaling session')
            this.status = 'failed'
            this.session = false
            this.mqttCamera.publishStreamState()
        }
    }

    async stop() {
        if (this.session) {
            this.worker.postMessage({ command: 'stop' })
        }
        this.status = 'inactive'
        this.session = false
    }
}