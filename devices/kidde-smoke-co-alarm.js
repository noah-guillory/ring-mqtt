import RingSocketDevice from './base-socket-device.js'

export default class KiddeSmokeCoAlarm extends RingSocketDevice {
    constructor(deviceInfo) {
        super(deviceInfo, 'alarm')
        this.deviceData.mdl = 'Kidde Smoke & CO Alarm'

        this.entity.smoke = {
            component: 'binary_sensor',
            device_class: 'smoke'
        }
        this.entity.co = {
            component: 'binary_sensor',
            device_class: 'gas',
            name: `CO`,
            unique_id: `${this.deviceId}_gas` // Force backward compatible unique ID for this entity
        }
    }

    publishState() {
        const smokeState = this.device.data.components['alarm.smoke'] && this.device.data.components['alarm.smoke'].alarmStatus === 'active' ? 'ON' : 'OFF'
        const coState = this.device.data.components['alarm.co'] && this.device.data.components['alarm.co'].alarmStatus === 'active' ? 'ON' : 'OFF'
        this.mqttPublish(this.entity.smoke.state_topic, smokeState)
        this.mqttPublish(this.entity.co.state_topic, coState)
        this.publishAttributes()
    }
}
