import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { AwsRekognitionService } from '../services/aws-rekognition/aws-rekognition.service';
import { HasuraService } from '../services/hasura/hasura.service';
import { AttendancesCoreService } from 'src/attendances/attendances.core.service';
import { UserService } from 'src/user/user.service';
import { html_code } from 'src/lms/certificate_html';
import { LMSCertificateDto } from 'src/lms/dto/lms-certificate.dto';
import { Method } from 'src/common/method/method';

const moment = require('moment');
const qr = require('qrcode');
const { parse, HTMLElement } = require('node-html-parser');

@Injectable()
export class PrepareCertificateHtmlCron {
	constructor(
		private readonly hasuraService: HasuraService,
		private configService: ConfigService,
		private readonly attendanceCoreService: AttendancesCoreService,
		private userService: UserService,
		private method: Method,
	) {}

	crypto = require('crypto');

	//cron issue certificate run every 5 minutes
	@Cron(CronExpression.EVERY_10_SECONDS)
	async testCron() {
		console.log('test encryption cron job ' + new Date());
		const aadhaar_no = '123456789012';
		console.log('Text aadhaar_no ', aadhaar_no);
		// Generate a 256-bit key (32 bytes)
		const key = 'IGHFJ/NdqgRB26Klg3aJV8ItHw6u/985zJZUJRlVAq0=';
		console.log('App Key ', key);
		const enc_aadhaar_no = await this.encrypt(aadhaar_no, key);
		console.log('Enc aadhaar_no ', enc_aadhaar_no);
		const dec_aadhaar_no = await this.decrypt(enc_aadhaar_no, key);
		console.log('Enc aadhaar_no ', dec_aadhaar_no);
	}
	//helper function
	async decrypt(text, secretKey) {
		const key = await Buffer.from(secretKey, 'base64');
		const decipher = await this.crypto.createDecipheriv(
			'aes-256-ecb',
			key,
			null,
		);
		const decrypted = await Buffer.concat([
			decipher.update(Buffer.from(text, 'base64')),
			decipher.final(),
		]);
		return decrypted.toString('utf8');
	}
	async encrypt(text, secretKey) {
		const key = await Buffer.from(secretKey, 'base64');
		const cipher = await this.crypto.createCipheriv(
			'aes-256-ecb',
			key,
			null,
		);
		const encrypted = await Buffer.concat([
			cipher.update(text, 'utf8'),
			cipher.final(),
		]);
		return encrypted.toString('base64');
	}

	//cron issue certificate run every 5 minutes
	@Cron(CronExpression.EVERY_5_MINUTES)
	async prepareCertificateHtml() {
		console.log('cron job: issueCertificate started at time ' + new Date());
		//fetch all test tracking data which has certificate_status null
		const userForIssueCertificate = await this.fetchTestTrackingData(
			parseInt(
				this.configService.get<string>(
					'LMS_CERTIFICATE_ISSUE_BATCH_SIZE',
				),
			),
		);
		if (userForIssueCertificate.length > 0) {
			for (let i = 0; i < userForIssueCertificate.length; i++) {
				let userTestData = userForIssueCertificate[i];
				let issue_status = '';
				let minPercentage = parseFloat(
					this.configService.get<string>(
						'LMS_CERTIFICATE_ISSUE_MIN_SCORE',
					),
				);
				let user_id = userTestData?.user_id;
				let test_id = userTestData?.test_id;
				let context = userTestData?.context;
				let context_id = userTestData?.context_id;
				let getUserList = await this.userService.getUserName(user_id);
				let user_name = '';
				if (getUserList.length > 0) {
					user_name += getUserList[0]?.first_name
						? (await this.method.CapitalizeEachWord(
								getUserList[0].first_name,
						  )) + ' '
						: '';
					user_name += getUserList[0]?.middle_name
						? (await this.method.CapitalizeEachWord(
								getUserList[0].middle_name,
						  )) + ' '
						: '';
					user_name += getUserList[0]?.last_name
						? (await this.method.CapitalizeEachWord(
								getUserList[0].last_name,
						  )) + ' '
						: '';
				}
				//get attendance status
				let attendance_valid = false;
				let usrAttendanceList =
					await this.attendanceCoreService.getUserAttendancePresentList(
						user_id,
						context,
						context_id,
					);
				let minAttendance = parseInt(
					this.configService.get<string>(
						'LMS_CERTIFICATE_ISSUE_MIN_ATTENDANCE',
					),
				);
				if (usrAttendanceList.length >= minAttendance) {
					attendance_valid = true;
				}
				//check certificate criteria
				if (userTestData?.score >= minPercentage && attendance_valid) {
					issue_status = 'true';
				} else {
					issue_status = 'false';
				}
				//issue certificate
				if (issue_status == 'true') {
					let certificateTemplate = html_code;
					let issuance_date = moment().format('YYYY-MM-DD');
					let issuance_date_tx = moment().format('DD MMM YYYY');
					let expiration_date = moment(issuance_date)
						.add(12, 'M')
						.format('YYYY-MM-DD');
					const lmsCertificate = new LMSCertificateDto({
						user_id: user_id,
						test_id: test_id,
						certificate_status: 'Issued',
						issuance_date: issuance_date,
						expiration_date: expiration_date,
					});
					const certificate_data = await this.createCertificateHtml(
						lmsCertificate,
					);
					if (certificate_data != null) {
						let certificate_id = certificate_data?.id;
						let uid = 'P-' + certificate_id + '-' + user_id;
						//update html code
						certificateTemplate = certificateTemplate.replace(
							'{{name}}',
							user_name,
						);
						certificateTemplate = certificateTemplate.replace(
							'{{issue_date}}',
							issuance_date_tx,
						);
						certificateTemplate = certificateTemplate.replace(
							'{{user_id}}',
							uid,
						);

						//qr code
						try {
							let qr_code_verify_link =
								this.configService.get<string>(
									'LMS_CERTIFICATE_VERIFY_URL',
								) +
								'' +
								certificate_id;

							let modifiedHtml = null;
							const modified = await new Promise(
								(resolve, reject) => {
									qr.toDataURL(
										qr_code_verify_link,
										function (err, code) {
											if (err) {
												resolve(null);
												return;
											}

											if (code) {
												const newHtml = code;

												const root =
													parse(certificateTemplate);

												// Find the img tag with id "qrcode"
												const qrcodeImg =
													root.querySelector(
														'#qr_certificate',
													);

												if (qrcodeImg) {
													qrcodeImg.setAttribute(
														'src',
														newHtml,
													);
													modifiedHtml =
														root.toString();

													resolve(modifiedHtml);
												} else {
													resolve(null);
												}
											} else {
												resolve(null);
											}
										},
									);
								},
							);
							if (modifiedHtml != null) {
								certificateTemplate = modifiedHtml;
							}
						} catch (e) {}
						//update certificate html
						const lmsCertificate = new LMSCertificateDto({
							certificate_html: certificateTemplate,
						});
						await this.updateCertificateHtml(
							lmsCertificate,
							certificate_id,
						);
					} else {
						//error in create certificate
					}
				}
				// Update in attendance data in database
				await this.markCertificateStatus(
					userTestData?.id,
					issue_status,
				);
			}
		}
	}
	async fetchTestTrackingData(limit: number) {
		const query = `
			query Getlms_test_tracking {
				lms_test_tracking(
				where:{
					certificate_status:{
						_is_null: true
					}
				},
				limit: ${limit}
				){
					id
					user_id
					test_id
					score
					context
					context_id
				}
			}
			`;
		try {
			const data_list = (await this.hasuraService.getData({ query }))
				?.data?.lms_test_tracking;
			return data_list;
		} catch (error) {
			return [];
		}
	}
	async createCertificateHtml(lmsCertificateDto: LMSCertificateDto) {
		let queryObj = '';
		Object.keys(lmsCertificateDto).forEach((e) => {
			if (lmsCertificateDto[e] && lmsCertificateDto[e] != '') {
				if (e === 'certificate_html') {
					queryObj += `${e}: ${JSON.stringify(
						JSON.stringify(lmsCertificateDto[e]),
					)}, `;
				} else if (Array.isArray(lmsCertificateDto[e])) {
					queryObj += `${e}: "${JSON.stringify(
						lmsCertificateDto[e],
					)}", `;
				} else {
					queryObj += `${e}: "${lmsCertificateDto[e]}", `;
				}
			}
		});

		let query = `mutation CreateTrainingCertificate {
			  insert_lms_training_certificate_one(object: {${queryObj}}) {
			   id
			  }
			}
			`;

		try {
			let query_response = await this.hasuraService.getData({
				query: query,
			});
			if (query_response?.data?.insert_lms_training_certificate_one) {
				//success issueCertificateHtml
				return query_response?.data
					?.insert_lms_training_certificate_one;
			} else {
				//error in issueCertificateHtml
				return null;
			}
		} catch (error) {
			//error in issueCertificateHtml
			return null;
		}
	}
	async updateCertificateHtml(lmsCertificateDto: LMSCertificateDto, id) {
		let queryObj = '';
		Object.keys(lmsCertificateDto).forEach((e) => {
			if (lmsCertificateDto[e] && lmsCertificateDto[e] != '') {
				if (e === 'certificate_html') {
					queryObj += `${e}: ${JSON.stringify(
						JSON.stringify(lmsCertificateDto[e]),
					)}, `;
				} else if (Array.isArray(lmsCertificateDto[e])) {
					queryObj += `${e}: "${JSON.stringify(
						lmsCertificateDto[e],
					)}", `;
				} else {
					queryObj += `${e}: "${lmsCertificateDto[e]}", `;
				}
			}
		});

		let query = `mutation UpdateTrainingCertificate {
			  update_lms_training_certificate_by_pk(
				pk_columns: {
					id: "${id}"
				},
				_set: {${queryObj}}
				) 
			  {
			   id
			  }
			}
			`;
		try {
			let query_response = await this.hasuraService.getData({
				query: query,
			});
			if (query_response?.data?.update_lms_training_certificate_by_pk) {
				//success issueCertificateHtml
				return query_response?.data
					?.update_lms_training_certificate_by_pk;
			} else {
				//error in issueCertificateHtml
				return null;
			}
		} catch (error) {
			//error in issueCertificateHtml
			return null;
		}
	}
	async markCertificateStatus(id, status) {
		let updateQuery = `
			mutation MyMutation {
				update_lms_test_tracking_by_pk (
					pk_columns: {
						id: "${id}"
					},
					_set: {
						certificate_status: ${status}
					}
				) {
					id
				}
			}
		`;
		try {
			return (
				(await this.hasuraService.getData({ query: updateQuery })).data
					.update_lms_test_tracking_by_pk.id === id
			);
		} catch (error) {
			return [];
		}
	}
}
