import * as chalk from 'chalk'
import { IotDpsClient } from '@azure/arm-deviceprovisioningservices'
import { v4 } from 'uuid'
import {
	uiServer,
	WebSocketConnection,
} from '@nordicsemiconductor/asset-tracker-cloud-device-ui-server'
import { deviceTopics } from './deviceTopics'
import { defaultConfig } from './defaultConfig'
import { connectDevice } from './connectDevice'
import { Status } from './fota'
import * as fs from 'fs'
import * as path from 'path'
import { AzureCliCredentials } from '@azure/ms-rest-nodeauth'
import { DeviceRegistrationState } from 'azure-iot-provisioning-service/dist/interfaces'

const cellId = process.env.CELL_ID

export const simulator = async (): Promise<void> => {
	const certJSON = process.argv[process.argv.length - 1]
	let privateKey: string,
		clientCert: string,
		deviceId: string,
		version: string,
		resourceGroupName: string,
		registration: DeviceRegistrationState | undefined,
		c: any
	try {
		c = JSON.parse(fs.readFileSync(certJSON, 'utf-8')) as {
			privateKey: string
			clientCert: string
			clientId: string
			resourceGroup: string
			registration?: DeviceRegistrationState
		}
		privateKey = c.privateKey
		clientCert = c.clientCert
		deviceId = c.clientId
		resourceGroupName = c.resourceGroup
		registration = c.registration
	} catch {
		throw new Error(`Failed to parse the certificate JSON using ${certJSON}!`)
	}

	const packageJSON = path.resolve(__dirname, '..', 'package.json')
	try {
		const pjson = JSON.parse(fs.readFileSync(packageJSON, 'utf-8'))
		version = pjson.version
	} catch {
		throw new Error(`Failed to parse ${packageJSON}!`)
	}

	const creds = await AzureCliCredentials.create()

	const {
		tokenInfo: { subscription },
	} = creds

	console.error(chalk.magenta('Subscription:'), chalk.yellow(subscription))
	console.error(
		chalk.magenta('Resource Group:'),
		chalk.yellow(resourceGroupName),
	)

	const armDpsClient = new IotDpsClient(
		creds as any,
		creds.tokenInfo.subscription,
	) // FIXME: This removes a TypeScript incompatibility error

	const { client, registration: actualRegistration } = await connectDevice({
		privateKey: Buffer.from(privateKey),
		clientCert: Buffer.from(clientCert),
		caCert: Buffer.from(
			fs.readFileSync(
				path.resolve(__dirname, '..', 'data', 'BaltimoreCyberTrustRoot.pem'),
				'utf-8',
			),
		),
		deviceId,
		registration,
		dps: async () => {
			const dps = await armDpsClient.iotDpsResource.get(
				`${resourceGroupName}ProvisioningService`,
				resourceGroupName,
			)
			return dps.properties as {
				serviceOperationsHostName: string
				idScope: string
			}
		},
		log: (info, context, ...rest) =>
			console.log(
				chalk.magenta(`${info}:`),
				chalk.yellow(context),
				...rest.map(chalk.gray),
			),
	})

	// Write registration information
	if (actualRegistration !== registration) {
		fs.writeFileSync(
			certJSON,
			JSON.stringify(
				{
					...c,
					registration: actualRegistration,
				},
				null,
				2,
			),
			'utf-8',
		)
		console.log(
			chalk.green(`Registration information written to`),
			chalk.blue(certJSON),
		)
		console.log(chalk.magenta('Registration information:'))
		console.log(chalk.yellow(JSON.stringify(actualRegistration, null, 2)))
	}

	const devRoam = {
		dev: {
			v: {
				band: 666,
				nw: 'LAN',
				modV: 'device-simulator',
				brdV: 'device-simulator',
				iccid: '12345678901234567890',
			},
			ts: Date.now(),
		},
		roam: {
			v: {
				rsrp: 70,
				area: 30401,
				mccmnc: 24201,
				cell: cellId === undefined ? 16964098 : parseInt(cellId, 10),
				ip: '0.0.0.0',
			},
			ts: Date.now(),
		},
		firmware: {
			status: 'current',
			currentFwVersion: version,
			pendingFwVersion: '',
		},
	} as const

	let cfg = {
		...defaultConfig,
	}

	let wsConnection: WebSocketConnection

	const sendConfigToUi = () => {
		if (wsConnection !== undefined) {
			console.log(chalk.magenta('[ws>'), JSON.stringify(cfg))
			wsConnection.send(JSON.stringify(cfg))
		}
	}

	const updateTwinReported = (update: { [key: string]: any }) => {
		console.log(chalk.magenta('>'), chalk.cyan(JSON.stringify(update)))
		client.publish(
			deviceTopics.updateTwinReported(v4()),
			JSON.stringify(update),
		)
	}

	const updateConfig = (updateConfig: { [key: string]: any }) => {
		cfg = {
			...cfg,
			...updateConfig,
		}
		console.log(chalk.blue('Config:'))
		console.log(cfg)
		updateTwinReported({ cfg, ...devRoam })
		sendConfigToUi()
	}

	/**
	 * Simulate the FOTA process
	 * @see https://docs.microsoft.com/en-us/azure/iot-hub/tutorial-firmware-update#update-the-firmware
	 */
	const simulateFota = ({ fwVersion }: { fwVersion: string }) => {
		updateTwinReported({
			firmware: {
				currentFwVersion: version,
				pendingFwVersion: fwVersion,
				status: Status.DOWNLOADING,
			},
		})
		setTimeout(() => {
			updateTwinReported({
				firmware: {
					currentFwVersion: fwVersion,
					pendingFwVersion: fwVersion,
					status: Status.CURRENT,
				},
			})
		}, 10 * 1000)
	}

	// See https://docs.microsoft.com/en-us/azure/iot-hub/iot-hub-mqtt-support#update-device-twins-reported-properties
	// A device must first subscribe to the $iothub/twin/res/# topic to receive the operation's responses from IoT Hub.
	client.subscribe(deviceTopics.twinResponses)
	// Receive desired properties update notifications
	// See https://docs.microsoft.com/en-us/azure/iot-hub/iot-hub-mqtt-support#receiving-desired-properties-update-notifications
	client.subscribe(deviceTopics.desiredUpdate.name)

	const getTwinPropertiesRequestId = v4()

	console.log(chalk.green('Connected:'), chalk.blueBright(deviceId))

	const port = await uiServer({
		deviceId: deviceId,
		onUpdate: updateTwinReported,
		onMessage: (message) => {
			console.log(
				chalk.magenta('>'),
				chalk.yellow(deviceTopics.messages(deviceId)),
			)
			console.log(chalk.magenta('>'), chalk.cyan(JSON.stringify(message)))
			client.publish(deviceTopics.messages(deviceId), JSON.stringify(message))
		},
		onBatch: (update) => {
			console.log(
				chalk.magenta('>'),
				chalk.yellow(deviceTopics.batch(deviceId)),
			)
			console.log(chalk.magenta('>'), chalk.cyan(JSON.stringify(update)))
			client.publish(deviceTopics.batch(deviceId), JSON.stringify(update))
		},
		onWsConnection: (c) => {
			console.log(chalk.magenta('[ws]'), chalk.cyan('connected'))
			wsConnection = c
			sendConfigToUi()
		},
	})

	console.log()
	console.log(
		'',
		chalk.yellowBright(
			`To control this device use this endpoint in the device simulator UI:`,
		),
		chalk.blueBright(`http://localhost:${port}`),
	)
	console.log()

	const getTwinPropertiesTopic = deviceTopics.getTwinProperties(
		getTwinPropertiesRequestId,
	)
	console.log(chalk.magenta('>'), chalk.yellow(getTwinPropertiesTopic))
	client.publish(getTwinPropertiesTopic, '')

	client.on('message', (topic, payload) => {
		console.log(chalk.magenta('<'), chalk.yellow(topic))
		if (payload.length) {
			console.log(chalk.magenta('<'), chalk.cyan(payload.toString()))
		}
		// Handle update reported messages
		if (
			topic ===
			deviceTopics.twinResponse({
				rid: getTwinPropertiesRequestId,
				status: 200,
			})
		) {
			const p = JSON.parse(payload.toString())
			updateConfig(p.desired.cfg)
			return
		}
		if (deviceTopics.updateTwinReportedAccepted.test(topic)) {
			// pass
			return
		}
		// Handle desired updates
		if (deviceTopics.desiredUpdate.test(topic)) {
			const desiredUpdate = JSON.parse(payload.toString())
			if (desiredUpdate.cfg !== undefined) {
				updateConfig(desiredUpdate.cfg)
			}
			if (desiredUpdate.firmware !== undefined) {
				simulateFota(desiredUpdate.firmware)
			}
			return
		}
		console.error(chalk.red(`Unexpected topic:`), chalk.yellow(topic))
	})

	client.on('error', (err) => {
		console.error(chalk.red(err.message))
	})
}
