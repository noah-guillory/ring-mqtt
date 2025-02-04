import { spawn } from 'child_process'
import pathToFfmpeg from 'ffmpeg-for-homebridge'

export class EventStream {
    constructor(device) {
        this.mqttCamera = device
        this.status = 'inactive'
        this.session = false
    }

    async start(rtspPublishUrl) {
        const eventSelect = this.mqttCamera.data.event_select.state.split(' ')
        const eventType = eventSelect[0].toLowerCase().replace('-', '_')
        const eventNumber = eventSelect[1]

        if (this.mqttCamera.data.event_select.recordingUrl.match(/Recording Not Found|Transcoding in Progress/)) {
            this.mqttCamera.debug(`No recording available for the ${(eventNumber==1?"":eventNumber==2?"2nd ":eventNumber==3?"3rd ":eventNumber+"th ")}most recent ${eventType} event!`)
            this.status = 'failed'
            this.session = false
            this.mqttCamera.publishStreamState()
            return
        }

        this.mqttCamera.debug(`Streaming the ${(eventNumber==1?"":eventNumber==2?"2nd ":eventNumber==3?"3rd ":eventNumber+"th ")}most recently recorded ${eventType} event`)

        try {
            if (this.mqttCamera.data.event_select.transcoded || this.mqttCamera.hevcEnabled) {
                // If camera is in HEVC mode, recordings are also in HEVC so transcode to H.264/AVC
                this.session = spawn(pathToFfmpeg, [
                    '-re',
                    '-i', this.mqttCamera.data.event_select.recordingUrl,
                    '-map', '0:v',
                    '-map', '0:a',
                    '-map', '0:a',
                    '-c:v', 'libx264',
                    '-g', '20',
                    '-keyint_min', '10',
                    '-crf', '23',
                    '-preset', 'ultrafast',
                    '-c:a:0', 'copy',
                    '-c:a:1', 'libopus',
                    '-flags', '+global_header',
                    '-rtsp_transport', 'tcp',
                    '-f', 'rtsp',
                    rtspPublishUrl
                ])
            } else {
                this.session = spawn(pathToFfmpeg, [
                    '-re',
                    '-i', this.mqttCamera.data.event_select.recordingUrl,
                    '-map', '0:v',
                    '-map', '0:a',
                    '-map', '0:a',
                    '-c:v', 'copy',
                    '-c:a:0', 'copy',
                    '-c:a:1', 'libopus',
                    '-flags', '+global_header',
                    '-rtsp_transport', 'tcp',
                    '-f', 'rtsp',
                    rtspPublishUrl
                ])
            }

            this.session.on('spawn', async () => {
                this.mqttCamera.debug(`The recorded ${eventType} event stream has started`)
                this.status = 'active'
                this.mqttCamera.publishStreamState()
            })

            this.session.on('close', async () => {
                this.mqttCamera.debug(`The recorded ${eventType} event stream has ended`)
                this.status = 'inactive'
                this.session = false
                this.mqttCamera.publishStreamState()
            })
        } catch(e) {
            this.mqttCamera.debug(e)
            this.status = 'failed'
            this.session = false
            this.mqttCamera.publishStreamState()
        }
    }

    async stop() {
        if (this.session) {
            this.session.kill()
            this.session = false
        }
        this.status = 'inactive'
    }
}