export const dpsTopics = {
	registrationResponses: '$dps/registrations/res/#',
	register: (rid: string): string =>
		`$dps/registrations/PUT/iotdps-register/?$rid=${rid}`,
	registationStatus: (rid: string, operationId: string): string =>
		`$dps/registrations/GET/iotdps-get-operationstatus/?$rid=${rid}&operationId=${operationId}`,
	registrationResult: (status: number): string =>
		`$dps/registrations/res/${status}`,
}
