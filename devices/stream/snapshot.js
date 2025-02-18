import { spawn } from 'child_process'
import utils from '../../lib/utils.js'
import pathToFfmpeg from 'ffmpeg-for-homebridge'

export class SnapshotStream {
    constructor(device) {
        this.mqttCamera = device
        this.status = 'inactive'
        this.livesnaps = {
            active: false,
            session: false,
            timeout: 0
        }
        this.keepalive = {
            active: false,
            session: false
        }
        this.snapshot = {
            active: false,
            interval: false,
            session: false
        }
    }

    async start(rtspPublishUrl) {
        if (!this.mqttCamera.data.snapshot.image) {
            this.mqttCamera.debug('Snapshot stream failed to start - No available snapshot')
            this.status = 'failed'
            this.mqttCamera.publishStreamState()
            return
        }

        try {
            await this.startSnapshotStream(rtspPublishUrl)
        } catch {
            this.mqttCamera.debug('Snapshot stream failed to start - Failed to spawn ffmpeg')
            this.status = 'failed'
            this.mqttCamera.publishStreamState()
        }
    }

    async startSnapshotStream(rtspPublishUrl) {
        return new Promise((resolve, reject) => {
            this.snapshot.session = spawn(pathToFfmpeg, [
                '-f', 'image2pipe',
                '-probesize', '32k',
                '-analyzeduration', '0',
                '-i', 'pipe:',
                '-vf', 'fps=5,scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2',
                '-c:v', 'libx264',
                '-b:v', '6M',
                '-r', '5',
                '-g', '1',
                '-preset', 'ultrafast',
                '-tune', 'zerolatency',
                '-avioflags', 'direct',
                '-f', 'rtsp',
                '-rtsp_transport', 'tcp',
                rtspPublishUrl
            ])

            this.snapshot.session.on('spawn', async () => {
                this.startSnapshotInterval()
                this.mqttCamera.debug('Snapshot stream transcoding session has started')
                this.status = 'active'
                this.mqttCamera.publishStreamState()
                resolve()
            })

            this.snapshot.session.on('close', () => {
                this.mqttCamera.debug('Snapshot stream transcoding session has ended')
                this.stop()
            })

            this.snapshot.session.on('error', reject)

        })
    }

    async startLivesnaps(duration) {
        if (this.livesnaps.active) { return }
        this.livesnaps.active = true

        this.mqttCamera.debug('Starting a live snapshot stream for camera')

        // We need a live stream, but don't want to rely on global keepalive so we start one here
        this.keepalive.session = spawn(pathToFfmpeg, [
            '-i', `rtsp://${this.mqttCamera.rtspCredentials}localhost:8554/${this.mqttCamera.deviceId}_live`,
            '-map', '0:a:0',
            '-c:a', 'copy',
            '-f', 'null',
            '/dev/null'
        ])

        this.keepalive.session.on('spawn', async () => {
            this.keepalive.active = true

            const mjpegParser = new MjpegParser()
            const liveStream = this.mqttCamera.streams.live
            const liveStreamStartTimeout = Date.now() + 5000
            while (!liveStream.altVideoData && Date.now() < liveStreamStartTimeout) {
                await utils.msleep(50)
            }

            if (liveStream.altVideoData) {
                this.livesnaps.session = spawn(pathToFfmpeg, [
                    '-hide_banner',
                    '-protocol_whitelist', 'pipe,udp,rtp,file,crypto',
                    '-probesize', '32K',
                    '-analyzeduration', '0',
                    '-f', 'sdp',
                    '-i', 'pipe:',
                    '-vf', 'fps=5,scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2',
                    '-c:v', 'mjpeg',
                    '-q:v', '3',
                    '-f', 'image2pipe',
                    'pipe:1'
                ])

                this.livesnaps.session.on('spawn', async () => {
                    liveStream.unbindAltVideoPorts()
                    this.livesnaps.session.stdin.write(liveStream.altVideoData.sdp)
                    this.livesnaps.session.stdin.end()
                })

                this.livesnaps.session.stdout.on('data', (chunk) => {
                    const jpegImage = mjpegParser.processChunk(chunk)
                    if (jpegImage) {
                        this.livesnaps.image = jpegImage
                    }
                })

                this.livesnaps.session.on('close', async () => {
                    this.mqttCamera.debug('The live snapshot stream has stopped')
                    this.mqttCamera.updateSnapshot('interval')
                    Object.assign(this.livesnaps, { active: false, session: false, image: false })
                })

                // The livesnap stream will stop after the specified duration
                this.livesnaps.timeout = Date.now() + 5000 + (duration * 1000)
                while (this.livesnaps.active && (Date.now() < this.livesnaps.timeout)) {
                    await utils.sleep(1)
                }
            } else {
                this.mqttCamera.debug('The live snapshot stream failed starting the live stream')
            }

            if (this.livesnaps.session) {
                this.livesnaps.session.kill()
            }

            if (this.keepalive.session) {
                this.keepalive.session.kill()
            }
        })

        this.keepalive.session.on('close', async () => {
            this.keepalive.active = false
            this.keepalive.session = false
        })
    }

    startSnapshotInterval() {
        this.snapshot.interval = setInterval(async () => {
            if (this.status === 'active') {
                try {
                    this.snapshot.session.stdin.write(this.livesnaps.image || this.mqttCamera.data.snapshot.image)
                } catch {
                    this.mqttCamera.debug('Writing image to snapshot stream failed')
                    this.stop()
                }
            } else {
                this.stop()
            }
        }, 50)
    }

    async stop() {
        clearInterval(this.snapshot.interval)
        this.snapshot.interval = false
        this.status = 'inactive'
        this.mqttCamera.publishStreamState()

        if (!this.snapshot.session) return

        const oldSession = this.snapshot.session
        this.snapshot.session = false

        try {
            oldSession.stdin.end()
            await Promise.race([
                new Promise((resolve) => {
                    oldSession.stdin.once('finish', () => {
                        oldSession.kill()
                        resolve()
                    })
                }),
                new Promise((_, reject) => {
                    setTimeout(() => {
                        reject()
                    }, 2000)
                })
            ])
        } catch {
            oldSession.kill('SIGKILL')
        }
    }
}

class MjpegParser {
    constructor() {
        this.buffer = Buffer.alloc(0)
        this.frameStart = null
    }

    processChunk(chunk) {
        this.buffer = Buffer.concat([this.buffer, chunk])

        if (this.frameStart === null) {
            for (let i = 0; i < this.buffer.length - 1; i++) {
                if (this.buffer[i] === 0xFF && this.buffer[i + 1] === 0xD8) {
                    this.frameStart = i
                    break
                }
            }
            if (this.frameStart === null) return null
        }

        for (let i = this.frameStart + 2; i < this.buffer.length - 1; i++) {
            if (this.buffer[i] === 0xFF && this.buffer[i + 1] === 0xD9) {
                const frame = this.buffer.slice(this.frameStart, i + 2)
                this.buffer = this.buffer.slice(i + 2)
                this.frameStart = null
                return frame
            }
        }

        if (this.buffer.length > 1000000) {
            this.buffer = Buffer.alloc(0)
            this.frameStart = null
        }

        return null
    }
}