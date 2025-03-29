import { Worker } from 'worker_threads'
import dgram from 'dgram'

export class LiveStream {
    constructor(device) {
        this.altVideoData = false
        this.mqttCamera = device
        this.rtpSocket = false
        this.rtcpSocket = false
        this.session = false
        this.status = 'inactive'

        this.worker = new Worker('./devices/stream/live-worker.js', {
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
                        this.altVideoData = message.altVideoData
                        this.bindAltVideoPorts()
                        break
                    case 'inactive':
                        this.clearSession('inactive')
                        break
                    case 'failed':
                        this.clearSession('failed')
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

    clearSession(status) {
        this.altVideoData = false
        this.session = false
        this.status = status
        this.unbindAltVideoPorts()
    }

    bindAltVideoPorts() {
        if (this.altVideoData) {
            this.rtpSocket = dgram.createSocket('udp4')
            this.rtcpSocket = dgram.createSocket('udp4')
            this.rtpSocket.bind(this.altVideoData.port)
            this.rtcpSocket.bind(this.altVideoData.port + 1)
        }
    }

    unbindAltVideoPorts() {
        if (this.rtpSocket) {
            this.rtpSocket.close()
        }
        if (this.rtcpSocket) {
            this.rtcpSocket.close()
        }
        this.rtpSocket = false
        this.rtcpSocket = false
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
            this.clearSession('failed')
            this.mqttCamera.publishStreamState()
        }
    }

    async stop() {
        if (this.session) {
            this.worker.postMessage({ command: 'stop' })
        }
        this.clearSession('inactive')
    }
}