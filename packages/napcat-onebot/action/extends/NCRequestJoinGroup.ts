import { OneBotAction } from '@/napcat-onebot/action/OneBotAction';
import { ActionName } from '@/napcat-onebot/action/router';
import { Static, Type } from '@sinclair/typebox';

const PayloadSchema = Type.Object({
  group_id: Type.String({ description: 'Group ID' }),
  comment: Type.Optional(Type.String({ description: 'Join comment or remark' })),
  group_answer: Type.Optional(Type.String({ description: 'Answer for group question' })),
  join_group_auth: Type.Optional(Type.String({ description: 'Join-group auth token override' })),
  service_type: Type.Optional(Type.Number({ description: 'QQNT serviceType override, e.g. 1 or 111' })),
  answer_mode: Type.Optional(Type.Union([
    Type.Literal('both'),
    Type.Literal('postscript'),
    Type.Literal('group_answer'),
  ], { description: 'Where to place the answer text; omitted means auto-select by group option' })),
  method: Type.Optional(Type.Union([
    Type.Literal('req'),
    Type.Literal('join'),
  ], { description: 'Underlying QQNT method; omitted means auto-select by group option' })),
  search: Type.Optional(Type.Boolean({ default: true, description: 'Search group info before requesting' })),
});

type PayloadType = Static<typeof PayloadSchema>;

const ReturnSchema = Type.Object({
  group_id: Type.String({ description: 'Group ID' }),
  method: Type.String({ description: 'Actual QQNT method used' }),
  answer_mode: Type.String({ description: 'Resolved answer placement mode' }),
  service_type: Type.Number({ description: 'Resolved QQNT serviceType used for request' }),
  join_info: Type.Any({ description: 'Resolved join-group info returned by QQNT preflight' }),
  no_verify_flag: Type.Any({ description: 'Result of getJoinGroupNoVerifyFlag for the selected serviceType' }),
  call_result: Type.Any({ description: 'Direct return value from QQNT native method' }),
  submitted: Type.Object({
    comment: Type.String({ description: 'Final postscript submitted to QQNT' }),
    group_answer: Type.String({ description: 'Final groupAnswer submitted to QQNT' }),
    join_group_auth: Type.String({ description: 'Final joinGroupAuth submitted to QQNT' }),
  }),
  packet_auth: Type.Optional(Type.String({ description: 'Auth token extracted from raw protocol packet (field 93)' })),
  resolved: Type.Object({
    group_name: Type.Optional(Type.String({ description: 'Resolved group name from search' })),
    group_option: Type.Optional(Type.Number({ description: 'Resolved join option from search' })),
    group_question: Type.Optional(Type.String({ description: 'Resolved group question from search' })),
    group_answer: Type.Optional(Type.String({ description: 'Resolved group answer from search' })),
    join_group_auth: Type.Optional(Type.String({ description: 'Resolved join-group auth from search' })),
  }),
});

type ReturnType = Static<typeof ReturnSchema>;

export class NCRequestJoinGroup extends OneBotAction<PayloadType, ReturnType> {
  override actionName = ActionName.NCRequestJoinGroup;
  override payloadSchema = PayloadSchema;
  override returnSchema = ReturnSchema;
  override actionSummary = '主动申请加群（实验性）';
  override actionDescription = '搜索群信息，提取 joinGroupAuth，调用 QQNT 原生方法申请加群。支持答题入群（groupOption=4）。';
  override actionTags = ['group-extend', 'experimental'];
  override payloadExample = {
    group_id: '123456789',
    group_answer: 'answer',
  };
  override returnExample = {
    group_id: '123456789',
    method: 'joinGroup',
    answer_mode: 'both',
    service_type: 1,
    join_info: null,
    no_verify_flag: null,
    call_result: { errCode: 0, errMsg: '', result: { result: 0 } },
    submitted: {
      comment: '问题：Question?\n答案：answer',
      group_answer: 'answer',
      join_group_auth: 'base64token...',
    },
    resolved: {
      group_name: 'test',
      group_option: 4,
      group_question: 'Question?',
      group_answer: '',
      join_group_auth: '',
    },
  };

  async _handle (payload: PayloadType): Promise<ReturnType> {
    const ret = await this.core.apis.GroupApi.activeJoinGroup(payload.group_id, {
      comment: payload.comment,
      groupAnswer: payload.group_answer,
      joinGroupAuth: payload.join_group_auth,
      serviceType: payload.service_type,
      answerMode: payload.answer_mode,
      method: payload.method,
      search: payload.search,
    });

    return {
      group_id: ret.groupCode,
      method: ret.method,
      answer_mode: ret.answerMode,
      service_type: ret.serviceType,
      join_info: ret.joinInfo ?? null,
      no_verify_flag: ret.noVerifyFlag ?? null,
      call_result: ret.callResult ?? null,
      packet_auth: ret.packetAuth ?? undefined,
      submitted: {
        comment: ret.requestPayload.postscript,
        group_answer: ret.requestPayload.groupAnswer,
        join_group_auth: ret.requestPayload.joinGroupAuth,
      },
      resolved: {
        group_name: ret.searchGroupInfo?.groupName,
        group_option: ret.searchGroupInfo?.groupOption,
        group_question: ret.searchGroupInfo?.groupQuestion,
        group_answer: ret.searchGroupInfo?.groupAnswer,
        join_group_auth: ret.searchGroupInfo?.joinGroupAuth,
      },
    };
  }
}
