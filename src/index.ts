import { format } from "date-fns";
import { QaseApi } from 'qaseio';
import { ResultCreate, ResultStatus, RunCreate } from 'qaseio/dist/src/models';
import { event, container } from 'codeceptjs';
const helpers = container.helpers();

const supportedHelpers = [
	'WebDriver',
	'Appium',
	'Nightmare',
	'Puppeteer',
	'Playwright',
	'TestCafe',
	'REST'
];

const defaultConfig = {
	apiKey: '',
	projectName: '',
	enabled: false,
};

let helper;

for (const helperName of supportedHelpers) {
	if (Object.keys(helpers).indexOf(helperName) > -1) {
		helper = helpers[helperName];
	}
}

module.exports = (config) => {
	config = Object.assign(defaultConfig, config);

	if (config.apiKey === '' || config.apiKey === undefined) throw new Error('Please provide proper Qaseio api key');
	if (config.projectName === '' || config.projectName === undefined) throw new Error('Please provide proper Qaseio project name');

	const qase = new QaseApi(config.apiKey);

	let runId;
	let failedTests = [];
	const passedTests = [];
	const errors = {};
	const prefixTag = '@C';
	const defaultElapsedTime = '1000';
	const ids = [];

	const runName = config.runName ? config.runName : `New test run on ${format(new Date(), 'yyyy-MM-dd\'T\'HH:mm:ss.s')}`;

	async function _createTestRunResult(projectName: string, runId: string|number,  results: { caseId :number, status: ResultStatus.PASSED | ResultStatus.FAILED, time_ms?: number, stacktrace?: string}) {
		try {
			return qase.results.create(projectName, runId, new ResultCreate(results.caseId, results.status, { time_ms: results.time_ms, stacktrace: results.stacktrace }));
		} catch (error) {
			console.log(`Cannot create test run result due to ${error}`);
		}
	}

	async function _getRuns(projectName): Promise<any> {
		try {
			const res = await qase.runs.getAll(projectName, {});
			return res.data;
		} catch (error) {
			console.log(`Cannot get new test run due to ${JSON.stringify(error)}`);
		}
	}

	async function _addTestRun(projectName:string, runName:string, cases: Array<number>, description: string, testRunTags?: Array<string>) {
		try {
			// @ts-ignore
			const res = await qase.runs.create(projectName, new RunCreate(runName, cases, { description, tags: testRunTags }));
			return res.data.id;
		} catch (error) {
			console.log(`Cannot create new test run due to ${JSON.stringify(error)}`);
		}
	}

	event.dispatcher.on(event.test.started, async (test) => {
		if (test.body) {
			if (test.body.includes('addExampleInTable')) {
				const qaseTag = /"qaseTag":"(@C\d+)"/.exec(test.title);
				if (qaseTag) {
					test.tags.push(qaseTag[1]);
				}
			}
		}
		test.startTime = Date.now();
	});

	const failedTestCaseIds = new Set();

	event.dispatcher.on(event.test.failed, async (test, err) => {
		test.endTime = Date.now();
		test.elapsed = Math.round(test.endTime - test.startTime);
		test.tags.forEach((tag) => {
			if (tag.includes(prefixTag)) {
				const caseId = parseInt(tag.split(prefixTag)[1], 10);
				if (!failedTestCaseIds.has(caseId)) {
					// else it also failed on retry so we shouldnt add in a duplicate
					failedTestCaseIds.add(caseId);
					failedTests.push({ case_id: caseId, elapsed: test.elapsed === 0 ? defaultElapsedTime : test.elapsed });
				}
				errors[tag.split(prefixTag)[1]] = err;
			}
		});
	});

	event.dispatcher.on(event.test.passed, (test) => {
		test.endTime = Date.now();
		test.elapsed = Math.round(test.endTime - test.startTime);
		test.tags.forEach(tag => {
			if (tag.includes(prefixTag)) {
				const caseId = parseInt(tag.split(prefixTag)[1], 10);
				// remove duplicates caused by retries
				if (failedTestCaseIds.has(caseId)) {
					failedTests = failedTests.filter(({ case_id }) => case_id !== caseId);
				}
				passedTests.push({ case_id: caseId, elapsed: test.elapsed === 0 ? defaultElapsedTime : test.elapsed });
			}
		});
	});

	event.dispatcher.once(event.all.after, async () => {
		const mergedTests = failedTests.concat(passedTests);

		mergedTests.forEach(test => {
			for (const [key, value] of Object.entries(test)) {
				if (key === 'case_id') {
					ids.push(value);
				}
			}
		});

		try {
			if (config.runId) {
				runId = config.runId;
			} else {

				const existingRuns = await _getRuns(config.projectName);

				if (existingRuns.length > 0 ) {
					for (const run of existingRuns) {
						if (run.title !== runName) {
							runId = await _addTestRun(config.projectName, runName, ids, config.description, config.testRunTags);
							break;
						}
					}
				} else {
					runId = await _addTestRun(config.projectName, runName, ids, config.description, config.testRunTags);
				}
			}

		} catch (error) {
			console.log(error);
		}

		if (ids.length > 0) {

			passedTests.forEach(test => {
				try {
					_createTestRunResult(config.projectName, runId, { caseId: test.case_id, status: ResultStatus.PASSED, time_ms: test.elapsed } ).then(() => console.log());
				} catch (e) {
					console.log(e);
				}

			});

			failedTests.forEach(test => {
				try {
					const errorString = errors[test.case_id]['message'] ? errors[test.case_id]['message'].replace(/\u001b\[.*?m/g, '') : errors[test.case_id];

					_createTestRunResult(config.projectName, runId, { caseId: test.case_id, status: ResultStatus.FAILED, time_ms: test.elapsed, stacktrace: errorString } ).then(() => console.log());
				} catch (e) {
					console.log(e);
				}
			});

		} else {
			console.log('There is no TC, hence no test run is created');
		}
	});

	return this;
};
