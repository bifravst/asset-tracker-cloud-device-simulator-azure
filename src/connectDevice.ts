import { connect, MqttClient } from 'mqtt'
import { DeviceRegistrationState } from 'azure-iot-provisioning-service/dist/interfaces'
import { provision } from './provision'

/**
 * Connect the device to the Azure IoT Hub.
 * If this device is not yet registered, connect to the Device Provisioning Service (DPS) to acquire the assigned IoT Hub hostname.
 */
export const connectDevice = async ({
	deviceId,
	privateKey,
	clientCert,
	caCert,
	dps,
	log,
	registration,
}: {
	deviceId: string
	privateKey: Buffer
	clientCert: Buffer
	caCert: Buffer
	registration?: DeviceRegistrationState
	dps: () => Promise<{ serviceOperationsHostName: string; idScope: string }>
	log?: (...args: any[]) => void
}): Promise<{
	client: MqttClient
	registration: DeviceRegistrationState
}> => {
	const acutalRegistration: DeviceRegistrationState =
		registration ??
		(await provision({
			caCert,
			clientCert,
			deviceId,
			dps,
			privateKey,
			log,
		}))
	const host = acutalRegistration.assignedHub
	return new Promise((resolve, reject) => {
		try {
			log?.(`Connecting to`, host)

			const client = connect({
				host,
				port: 8883,
				key: privateKey,
				cert: clientCert,
				rejectUnauthorized: true,
				clientId: deviceId,
				protocol: 'mqtts',
				username: `${host}/${deviceId}/?api-version=2018-06-30`,
				version: 4,
			})
			client.on('connect', async () => {
				log?.('Connected', deviceId)
				resolve({
					client,
					registration: acutalRegistration,
				})
			})
		} catch (err) {
			reject(err)
		}
	})
}
