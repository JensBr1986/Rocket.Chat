import { Meteor } from 'meteor/meteor';
import { Random } from 'meteor/random';
import { HTTP } from 'meteor/http';
import { TAPi18n } from 'meteor/rocketchat:tap-i18n';
import xml2js from 'xml2js';

import BigBlueButtonApi from '../../../bigbluebutton/server';
import { SystemLogger } from '../../../../server/lib/logger/system';
import { settings } from '../../../settings/server';
import { Rooms, Users } from '../../../models/server';
import { saveStreamingOptions } from '../../../channel-settings/server';
import { API } from '../../../api/server';

const parser = new xml2js.Parser({
	explicitRoot: true,
});

const parseString = Meteor.wrapAsync(parser.parseString);

const getBBBAPI = () => {
	const url = settings.get('bigbluebutton_server');
	const secret = settings.get('bigbluebutton_sharedSecret');
	const api = new BigBlueButtonApi(`${ url }/bigbluebutton/api`, secret);
	return { api, url };
};

Meteor.methods({
	bbbJoin({ rid }) {
		if (!this.userId) {
			throw new Meteor.Error('error-invalid-user', 'Invalid user', { method: 'bbbJoin' });
		}

		if (!Meteor.call('canAccessRoom', rid, this.userId)) {
			throw new Meteor.Error('error-invalid-user', 'Invalid user', { method: 'bbbJoin' });
		}

		if (!settings.get('bigbluebutton_Enabled')) {
			throw new Meteor.Error('error-not-allowed', 'Not Allowed', { method: 'bbbJoin' });
		}

		const { api } = getBBBAPI();
		const meetingID = settings.get('uniqueID') + rid;
		const room = Rooms.findOneById(rid);
		const createUrl = api.urlFor('create', {
			name: room.t === 'd' ? 'Direct' : room.name,
			meetingID,
			attendeePW: 'ap',
			moderatorPW: 'mp',
			welcome: '<br>Welcome to <b>%%CONFNAME%%</b>!',
			meta_html5chat: false,
			meta_html5navbar: false,
			meta_html5autoswaplayout: true,
			meta_html5autosharewebcam: false,
			meta_html5hidepresentation: true,
		});

		const createResult = HTTP.get(createUrl);
		const doc = parseString(createResult.content);

		if (doc.response.returncode[0]) {
			const user = Users.findOneById(this.userId);

			const hookApi = api.urlFor('hooks/create', {
				meetingID,
				callbackURL: Meteor.absoluteUrl(`api/v1/videoconference.bbb.update/${ meetingID }`),
			});

			const hookResult = HTTP.get(hookApi);

			if (hookResult.statusCode !== 200) {
				// TODO improve error logging
				SystemLogger.error(hookResult);
				return;
			}

			if (settings.get('bigbluebutton_meeting_start_notification_Enabled') && doc.response.messageKey[0] !== 'duplicateWarning') {
				const meeting_start_notification = TAPi18n.__(settings.get('bigbluebutton_meeting_start_notification'), {}, user.language);
				if (meeting_start_notification) {
					const msgObject = {
						_id: Random.id(),
						rid,
						msg: meeting_start_notification,
					};
					Meteor.call('sendMessage', msgObject);
				}
			}

			saveStreamingOptions(rid, {
				type: 'call',
			});

			const bigbluebutton_userdata = settings.get('bigbluebutton_userdata').trim();
			let bigbluebutton_userdata_obj = {};
			if (bigbluebutton_userdata) {
				try {
					bigbluebutton_userdata_obj = JSON.parse(bigbluebutton_userdata);
				} catch (err) {
					console.log(`Unexpected error : ${ err.message }`);
					return;
				}
			}

			let bigbluebutton_fullName = user.username;
			if (user[settings.get('bigbluebutton_fullname')]) {
				bigbluebutton_fullName = user[settings.get('bigbluebutton_fullname')];
			}

			return {
				url: api.urlFor('join', Object.keys(bigbluebutton_userdata_obj)
					.filter((key) => key.startsWith('userdata-bbb'))
					.reduce((obj, key) => (
						{
							...obj,
							[`custom_${ key }`]: bigbluebutton_userdata_obj[key],
						}
					), {
						password: 'mp', // mp if moderator ap if attendee
						meetingID,
						fullName: bigbluebutton_fullName,
						userID: user._id,
						joinViaHtml5: true,
						avatarURL: Meteor.absoluteUrl(`avatar/${ user.username }`),
						// clientURL: `${ url }/html5client/join`,
					})),
			};
		}
	},

	bbbEnd({ rid }) {
		if (!this.userId) {
			throw new Meteor.Error('error-invalid-user', 'Invalid user', { method: 'bbbEnd' });
		}

		if (!Meteor.call('canAccessRoom', rid, this.userId)) {
			throw new Meteor.Error('error-invalid-user', 'Invalid user', { method: 'bbbEnd' });
		}

		if (!settings.get('bigbluebutton_Enabled')) {
			throw new Meteor.Error('error-not-allowed', 'Not Allowed', { method: 'bbbEnd' });
		}

		const { api } = getBBBAPI();
		const meetingID = settings.get('uniqueID') + rid;
		const endApi = api.urlFor('end', {
			meetingID,
			password: 'mp', // mp if moderator ap if attendee
		});

		const endApiResult = HTTP.get(endApi);

		if (endApiResult.statusCode !== 200) {
			saveStreamingOptions(rid, {});
			throw new Meteor.Error(endApiResult);
		}
		const doc = parseString(endApiResult.content);

		if (['SUCCESS', 'FAILED'].includes(doc.response.returncode[0])) {
			saveStreamingOptions(rid, {});
		}
	},
});

API.v1.addRoute('videoconference.bbb.update/:id', { authRequired: false }, {
	post() {
		// TODO check checksum
		const event = JSON.parse(this.bodyParams.event)[0];
		const eventType = event.data.id;
		const meetingID = event.data.attributes.meeting['external-meeting-id'];
		const rid = meetingID.replace(settings.get('uniqueID'), '');

		SystemLogger.debug(eventType, rid);

		if (eventType === 'meeting-ended') {
			saveStreamingOptions(rid, {});
		}

		// if (eventType === 'user-left') {
		// 	const { api } = getBBBAPI();

		// 	const getMeetingInfoApi = api.urlFor('getMeetingInfo', {
		// 		meetingID
		// 	});

		// 	const getMeetingInfoResult = HTTP.get(getMeetingInfoApi);

		// 	if (getMeetingInfoResult.statusCode !== 200) {
		// 		// TODO improve error logging
		// 		SystemLogger.error({ getMeetingInfoResult });
		// 	}

		// 	const doc = parseString(getMeetingInfoResult.content);

		// 	if (doc.response.returncode[0]) {
		// 		const participantCount = parseInt(doc.response.participantCount[0]);
		// 		SystemLogger.debug(participantCount);
		// 	}
		// }
	},
});
