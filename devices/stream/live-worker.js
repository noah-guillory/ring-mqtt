import { parentPort, workerData } from 'worker_threads'
import { WebrtcConnection } from './lib/webrtc-connection.js'
import { StreamingSession } from './lib/streaming-session.js'

class LiveStreamWorker {
    constructor(deviceName, doorbotId) {
        this.deviceName = deviceName
        this.doorbotId = doorbotId
        this.liveStream = null
        this.altVideoData = null
        this.stopping = false

        this.processMessages()
    }

    processMessages() {
        parentPort.on("message", async (data) => {
            const { command, streamData } = data

            try {
                switch (command) {
                    case 'start':
                        await this.start(streamData)
                        break;
                    case 'stop':
                        await this.stop()
                        break;
                    default:
                        this.logError(`Unknown command received: ${command}`)
                }
            } catch (error) {
                this.logError(`Error handling command ${command}: ${error.message}`)
                this.updateState('failed')
            }
        })
    }

    async start(streamData) {
        if (this.isStreamStopping) {
            this.logError("Live stream could not be started because it is in stopping state")
            this.updateState('failed')
            return
        }

        if (this.liveStream) {
            this.logError("Live stream could not be started because there is already an active stream")
            this.updateState('active')
            return
        }

        await this.startLiveStream(streamData)
    }

    async stop() {
        if (this.liveStream) {
            await this.stopLiveStream()
        }
    }

    async startLiveStream(streamData) {
        this.logInfo('Live stream WebRTC worker received start command')

        try {
            const cameraData = {
                name: this.deviceName,
                id: this.doorbotId
            }

            const streamConnection = new WebrtcConnection(streamData.ticket, cameraData)
            this.liveStream = new StreamingSession(cameraData, streamConnection)

            this.handleCallState()
            this.handleCallEnded()
            await this.startTranscoding(streamData.rtspPublishUrl)
        } catch (error) {
            this.logError(error)
            this.updateState('failed')
            this.liveStream = null
        }
    }

    handleCallState() {
        this.liveStream.connection.pc.onConnectionState.subscribe(async (state) => {
            switch(state) {
                case 'connected':
                    this.updateState('active')
                    this.logInfo('Live stream WebRTC session is connected')
                    break
                case 'failed':
                    this.updateState('failed')
                    this.logInfo('Live stream WebRTC connection has failed')
                    this.liveStream.stop()
                    await new Promise(res => setTimeout(res, 2000))
                    this.liveStream = null
                    break
            }
        })
    }

    handleCallEnded() {
        this.liveStream.onCallEnded.subscribe(() => {
            this.logInfo('Live stream WebRTC session has disconnected')
            this.updateState('inactive')
            this.liveStream = null
        });
    }

    async startTranscoding(rtspPublishUrl) {
        this.logInfo('Live stream transcoding process is starting')

        const transcodingConfig = {
            input: [
                '-probesize', '32K',
                '-analyzeduration', '0',
            ],
            audio: [
                '-map', '0:a',
                '-c:a:0', 'aac',
                '-map', '0:a',
                '-c:a:1', 'copy'
            ],
            video: [
                '-map', '0:v',
                '-c:v', 'copy'
            ],
            output: [
                '-ss', '0.2',
                '-flags', '+global_header',
                '-f', 'rtsp',
                '-rtsp_transport', 'tcp',
                rtspPublishUrl
        ]}

        this.altVideoData = await this.liveStream.startTranscoding(transcodingConfig)
        this.logInfo('Live stream transcoding process has started')
    }

    async stopLiveStream() {
        if (this.stopping)  { return }

        this.stopping = true
        let stopTimeout = 10

        this.liveStream.stop()

        while (this.liveStream && stopTimeout > 0) {
            await new Promise(res => setTimeout(res, 200))
            stopTimeout -= 1

            if (this.liveStream) {
                this.logInfo('Live stream failed to stop on request, trying again...')
                this.liveStream.stop()
            } else {
                this.logError('Live stream failed to stop on request, deleting anyway...')
                this.updateState('inactive')
                this.liveStream = null
            }
        }

        this.stopping = false
    }

    // Helper methods for logging and state updates
    logInfo(message) {
        parentPort.postMessage({ type: 'log_info', data: message })
    }

    logError(message) {
        parentPort.postMessage({ type: 'log_error', data: message })
    }

    updateState(state) {
        parentPort.postMessage({ type: 'state', data: state, altVideoData: this.altVideoData })
    }
}

// Initialize the worker
const worker = new LiveStreamWorker(workerData.deviceName, workerData.doorbotId)
export default worker