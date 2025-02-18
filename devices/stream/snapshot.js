import { spawn } from 'child_process'
import utils from '../../lib/utils.js'
import pathToFfmpeg from 'ffmpeg-for-homebridge'

export class SnapshotStream {
    constructor(device) {
        this.mqttCamera = device
        this.status = 'inactive'
        this.interval = null
        this.livesnaps = {
            active: false,
            session: false,
            timeout: 0
        }
        this.keepalive = {
            active: false,
            session: false
        }
        this.rtsp = {
            active: false,
            session: false
        }
        this.snapshot = {
            active: false,
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
        this.rtsp.session = spawn(pathToFfmpeg, [
            '-f', 'mpegts',
            '-probesize', '32k',
            '-analyzeduration', '0',
            '-i', 'pipe:',
            '-ss', '.2',
            '-c:v', 'copy',
            '-avioflags', 'direct',
            '-f', 'rtsp',
            '-rtsp_transport', 'tcp',
            rtspPublishUrl
        ])

        // Handle process exit
        this.rtsp.session.on('close', () => {
            this.mqttCamera.debug('Snapshot stream transcoding session has ended')
            this.stop()
        })

        // Return a promise that resolves when the process is ready
        return new Promise((resolve, reject) => {
            this.rtsp.session.on('spawn', async () => {
                this.snapshot.session = spawn(pathToFfmpeg, [
                    '-hide_banner',
                    '-f', 'image2pipe',
                    '-probesize', '32k',
                    '-analyzeduration', '0',
                    '-i', 'pipe:',
                    '-vf', 'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2',
                    '-sws_flags', 'lanczos',
                    '-c:v', 'libx264',
                    '-b:v', '6M',
                    '-r', '5',
                    '-g', '1',
                    '-preset', 'ultrafast',
                    '-tune', 'zerolatency',
                    '-avioflags', 'direct',
                    '-f', 'mpegts',
                    'pipe:1'
                ])

                this.snapshot.session.on('spawn', async () => {
                    this.startSnapshotInterval()
                    this.mqttCamera.debug('Snapshot stream transcoding session has started')
                    this.status = 'active'
                    this.mqttCamera.publishStreamState()
                    resolve()
                })

                this.snapshot.session.stdout.once('data', () => {
                    this.snapshot.session.stdout.pipe(this.rtsp.session.stdin)
                })
            })

            this.rtsp.session.on('error', reject)
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

            const liveStream = this.mqttCamera.streams.live
            const liveStreamStartTimeout = Date.now() + 5000
            while (!liveStream.altVideoData && Date.now() < liveStreamStartTimeout) {
                await utils.msleep(50)
            }

            if (liveStream.altVideoData) {
                this.livesnaps.session = spawn(pathToFfmpeg, [
                    '-hide_banner',
                    '-protocol_whitelist', 'pipe,udp,rtp,fd,file,crypto',
                    '-fflags', 'nobuffer',
                    '-flags', 'low_delay',
                    '-use_wallclock_as_timestamps', '1',
                    '-itsoffset', '-0.2',
                    '-probesize', '32K',
                    '-analyzeduration', '0',
                    '-f', 'sdp',
                    '-i', 'pipe:',
                    '-vf', 'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2',
                    '-sws_flags', 'lanczos',
                    '-c:v', 'libx264',
                    '-b:v', '6M',
                    '-preset', 'ultrafast',
                    '-tune', 'zerolatency',
                    '-r', '5',
                    '-g', '1',
                    '-avioflags', 'direct',
                    '-f', 'mpegts',
                    'pipe:1'
                ])

                this.livesnaps.session.on('spawn', async () => {
                    liveStream.unbindAltVideoPorts()
                    this.livesnaps.session.stdin.write(liveStream.altVideoData.sdp)
                    this.livesnaps.session.stdin.end()
                })

                this.livesnaps.session.stdout.once('data', () => {
                    this.snapshot.session.stdout.unpipe(this.rtsp.session.stdin)
                    this.livesnaps.session.stdout.pipe(this.rtsp.session.stdin)
                })

                this.livesnaps.session.on('close', async () => {
                    this.mqttCamera.debug('The live snapshot stream has stopped')
                    this.mqttCamera.updateSnapshot('interval')
                    this.livesnaps.session.stdout.unpipe(this.rtsp.session.stdin)
                    this.snapshot.session.stdout.pipe(this.rtsp.session.stdin)
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
        this.interval = setInterval(async () => {
            if (this.status === 'active') {
                try {
                    this.snapshot.session.stdin.write(this.mqttCamera.data.snapshot.image)
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
        clearInterval(this.interval)
        this.interval = null
        this.status = 'inactive'
        this.mqttCamera.publishStreamState()

        if (!this.rtsp.session) return

        const rtspSession = this.rtsp.session
        this.rtsp.session = false

        try {
            rtspSession.stdin.end()
            await Promise.race([
                new Promise((resolve) => {
                    rtspSession.stdin.once('finish', () => {
                        rtspSession.kill()
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
            rtspSession.kill('SIGKILL')
        }
    }
}