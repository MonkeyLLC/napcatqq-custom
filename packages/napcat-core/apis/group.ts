import {
  GeneralCallResult,
  GroupMember,
  NTGroupMemberRole,
  NTGroupRequestOperateTypes,
  InstanceContext,
  KickMemberV2Req,
  MemberExtSourceType,
  NapCatCore,
  GroupNotify,
  GroupInfoSource,
  ShutUpGroupMember,
  Peer,
  ChatType,
} from '@/napcat-core/index';
import { isNumeric, solveAsyncProblem } from 'napcat-common/src/helper';
import { LimitedHashTable } from 'napcat-common/src/message-unique';
import { CancelableTask, TaskExecutor } from 'napcat-common/src/cancel-task';
import { createGroupDetailInfoV2Param, createGroupExtFilter, createGroupExtInfo } from '../data';
import { NTEventWrapper } from '../helper/event';

export class NTQQGroupApi {
  context: InstanceContext;
  core: NapCatCore;
  groupMemberCache: Map<string, Map<string, GroupMember>> = new Map<string, Map<string, GroupMember>>();
  essenceLRU = new LimitedHashTable<number, string>(1000);
  // psKey 滑动缓存，TTL 60 秒，惰性删除（不主动清理，等下次访问检测到过期再刷新）
  private _qunPskeyCache: { value: string; expireAt: number; } | null = null;

  constructor (context: InstanceContext, core: NapCatCore) {
    this.context = context;
    this.core = core;
  }

  /** 获取 qun.qq.com 域名的 psKey，滑动 TTL 60 秒（每次访问顺延） */
  private async getQunPskey (): Promise<string> {
    const now = Date.now();
    if (this._qunPskeyCache && this._qunPskeyCache.expireAt > now) {
      // 滑动 TTL：每次访问都顺延过期时间
      this._qunPskeyCache.expireAt = now + 60 * 1000;
      return this._qunPskeyCache.value;
    }
    // 过期或为空，惰性删除旧值（直接覆盖）并重新获取
    const psKey = (await this.core.apis.UserApi.getPSkey(['qun.qq.com'])).domainPskeyMap.get('qun.qq.com')!;
    this._qunPskeyCache = { value: psKey, expireAt: now + 60 * 1000 };
    return psKey;
  }

  async setGroupRemark (groupCode: string, remark: string) {
    return this.context.session.getGroupService().modifyGroupRemark(groupCode, remark);
  }

  async fetchGroupDetail (groupCode: string) {
    const [, detailInfo] = await this.core.eventWrapper.callNormalEventV2(
      'NodeIKernelGroupService/getGroupDetailInfo',
      'NodeIKernelGroupListener/onGroupDetailInfoChange',
      [groupCode, GroupInfoSource.KDATACARD],
      (ret) => ret.result === 0,
      (detailInfo) => detailInfo.groupCode === groupCode,
      1,
      5000
    );
    return detailInfo;
  }

  async initApi () {
    this.initCache().then().catch(e => this.context.logger.logError(e));
  }

  async createGrayTip (groupCode: string, tip: string) {
    return this.context.session.getMsgService().addLocalJsonGrayTipMsg(
      {
        chatType: ChatType.KCHATTYPEGROUP,
        peerUid: groupCode,
      } as Peer,
      {
        busiId: 2201,
        jsonStr: JSON.stringify({ align: 'center', items: [{ txt: tip, type: 'nor' }] }),
        recentAbstract: tip,
        isServer: false,
      },
      true,
      true
    );
  }

  async initCache () {
    for (const group of await this.getGroups(true)) {
      this.refreshGroupMemberCache(group.groupCode, false).then().catch(e => this.context.logger.logError(e));
    }
  }

  async fetchGroupEssenceList (groupCode: string) {
    const pskey = await this.getQunPskey();
    return this.context.session.getGroupService().fetchGroupEssenceList({
      groupCode,
      pageStart: 0,
      pageLimit: 300,
    }, pskey);
  }

  async getGroupShutUpMemberList (groupCode: string): Promise<ShutUpGroupMember[]> {
    const executor: TaskExecutor<ShutUpGroupMember[]> = async (resolve, reject, onCancel) => {
      this.core.eventWrapper.registerListen(
        'NodeIKernelGroupListener/onShutUpMemberListChanged',
        (group_id) => group_id === groupCode,
        1,
        1000
      ).then((data) => {
        resolve(data[1]);
      }).catch(reject);

      onCancel(() => {
        reject(new Error('Task was canceled'));
      });
    };

    const task = new CancelableTask(executor);
    this.context.session.getGroupService().getGroupShutUpMemberList(groupCode).then(e => {
      if (e.result !== 0) {
        task.cancel();
      }
    });
    return await task.catch(() => []);
  }

  async clearGroupNotifiesUnreadCount (doubt: boolean) {
    return this.context.session.getGroupService().clearGroupNotifiesUnreadCount(doubt);
  }

  async setGroupAvatar (groupCode: string, filePath: string) {
    return this.context.session.getGroupService().setHeader(groupCode, filePath);
  }

  // 0 0 无需管理员审核
  // 0 2 需要管理员审核
  // 1 2 禁止Bot入群( 最好只传一个1 ？)
  async setGroupRobotAddOption (groupCode: string, robotMemberSwitch?: number, robotMemberExamine?: number) {
    const extInfo = createGroupExtInfo(groupCode);
    const groupExtFilter = createGroupExtFilter();
    if (robotMemberSwitch !== undefined) {
      extInfo.extInfo.inviteRobotMemberSwitch = robotMemberSwitch;
      groupExtFilter.inviteRobotMemberSwitch = 1;
    }
    if (robotMemberExamine !== undefined) {
      extInfo.extInfo.inviteRobotMemberExamine = robotMemberExamine;
      groupExtFilter.inviteRobotMemberExamine = 1;
    }
    return this.context.session.getGroupService().modifyGroupExtInfoV2(extInfo, groupExtFilter);
  }

  async setGroupAddOption (groupCode: string, option: {
    addOption: number;
    groupQuestion?: string;
    groupAnswer?: string;
  }) {
    const param = createGroupDetailInfoV2Param(groupCode);
    // 设置要修改的目标
    param.filter.addOption = 1;
    if (option.addOption === 4 || option.addOption === 5) {
      // 4 问题进入答案 5 问题管理员批准
      param.filter.groupQuestion = 1;
      param.filter.groupAnswer = option.addOption === 4 ? 1 : 0;
      param.modifyInfo.groupQuestion = option.groupQuestion || '';
      param.modifyInfo.groupAnswer = option.addOption === 4 ? option.groupAnswer || '' : '';
    }
    param.modifyInfo.addOption = option.addOption;
    return this.context.session.getGroupService().modifyGroupDetailInfoV2(param, 0);
  }

  async setGroupSearch (groupCode: string, option: {
    noCodeFingerOpenFlag?: number;
    noFingerOpenFlag?: number;
  }) {
    const param = createGroupDetailInfoV2Param(groupCode);
    if (option.noCodeFingerOpenFlag) {
      param.filter.noCodeFingerOpenFlag = 1;
      param.modifyInfo.noCodeFingerOpenFlag = option.noCodeFingerOpenFlag;
    }
    if (option.noFingerOpenFlag) {
      param.filter.noFingerOpenFlag = 1;
      param.modifyInfo.noFingerOpenFlag = option.noFingerOpenFlag;
    }
    return this.context.session.getGroupService().modifyGroupDetailInfoV2(param, 0);
  }

  async getGroups (forced: boolean = false) {
    const [, , groupList] = await this.core.eventWrapper.callNormalEventV2(
      'NodeIKernelGroupService/getGroupList',
      'NodeIKernelGroupListener/onGroupListUpdate',
      [forced]
    );
    return groupList;
  }

  async getGroupExtFE0Info (groupCodes: Array<string>, forced = true) {
    return this.context.session.getGroupService().getGroupExt0xEF0Info(
      groupCodes,
      [],
      {
        bindGuildId: 1,
        blacklistExpireTime: 1,
        companyId: 1,
        essentialMsgPrivilege: 1,
        essentialMsgSwitch: 1,
        fullGroupExpansionSeq: 1,
        fullGroupExpansionSwitch: 1,
        gangUpId: 1,
        groupAioBindGuildId: 1,
        groupBindGuildIds: 1,
        groupBindGuildSwitch: 1,
        groupExcludeGuildIds: 1,
        groupExtFlameData: 1,
        groupFlagPro1: 1,
        groupInfoExtSeq: 1,
        groupOwnerId: 1,
        groupSquareSwitch: 1,
        hasGroupCustomPortrait: 1,
        inviteRobotMemberExamine: 1,
        inviteRobotMemberSwitch: 1,
        inviteRobotSwitch: 1,
        isLimitGroupRtc: 1,
        lightCharNum: 1,
        luckyWord: 1,
        luckyWordId: 1,
        msgEventSeq: 1,
        qqMusicMedalSwitch: 1,
        reserve: 1,
        showPlayTogetherSwitch: 1,
        starId: 1,
        todoSeq: 1,
        viewedMsgDisappearTime: 1,
      },
      forced
    );
  }

  async getGroupMemberAll (groupCode: string, forced = false) {
    return this.context.session.getGroupService().getAllMemberList(groupCode, forced);
  }

  async refreshGroupMemberCache (groupCode: string, isWait = true) {
    const updateCache = async () => {
      try {
        const members = await this.getGroupMemberAll(groupCode, true);
        this.groupMemberCache.set(groupCode, members.result.infos);
      } catch (e) {
        this.context.logger.logError(`刷新群成员缓存失败, 群号: ${groupCode}, 错误: ${e}`);
      }
    };

    if (isWait) {
      await updateCache();
    } else {
      updateCache();
    }

    return this.groupMemberCache.get(groupCode);
  }

  async refreshGroupMemberCachePartial (groupCode: string, uid: string) {
    const member = await this.getGroupMemberEx(groupCode, uid, true);
    if (member) {
      this.groupMemberCache.get(groupCode)?.set(uid, member);
    }
    return member;
  }

  async getGroupMember (groupCode: string | number, memberUinOrUid: string | number) {
    const groupCodeStr = groupCode.toString();
    const memberUinOrUidStr = memberUinOrUid.toString();

    // 获取群成员缓存
    let members = this.groupMemberCache.get(groupCodeStr);
    if (!members) {
      members = (await this.refreshGroupMemberCache(groupCodeStr, true));
    }

    const getMember = () => {
      if (isNumeric(memberUinOrUidStr)) {
        return Array.from(members!.values()).find(member => member.uin === memberUinOrUidStr);
      } else {
        return members!.get(memberUinOrUidStr);
      }
    };

    let member = getMember();
    // 如果缓存中不存在该成员，尝试刷新缓存
    if (!member) {
      members = (await this.refreshGroupMemberCache(groupCodeStr, true));
      member = getMember();
    }
    return member;
  }

  async getGroupRecommendContactArkJson (groupCode: string) {
    return this.context.session.getGroupService().getGroupRecommendContactArkJson(groupCode);
  }

  async creatGroupFileFolder (groupCode: string, folderName: string) {
    return this.context.session.getRichMediaService().createGroupFolder(groupCode, folderName);
  }

  async delGroupFile (groupCode: string, files: Array<string>) {
    return this.context.session.getRichMediaService().deleteGroupFile(groupCode, [102], files);
  }

  async delGroupFileFolder (groupCode: string, folderId: string) {
    return this.context.session.getRichMediaService().deleteGroupFolder(groupCode, folderId);
  }

  async transGroupFile (groupCode: string, fileId: string) {
    return this.context.session.getRichMediaService().transGroupFile(groupCode, fileId);
  }

  async addGroupEssence (groupCode: string, msgId: string) {
    const MsgData = await this.context.session.getMsgService().getMsgsIncludeSelf({
      chatType: 2,
      guildId: '',
      peerUid: groupCode,
    }, msgId, 1, false);
    if (!MsgData.msgList[0]) {
      throw new Error('消息不存在');
    }
    const param = {
      groupCode,
      msgRandom: parseInt(MsgData.msgList[0].msgRandom),
      msgSeq: parseInt(MsgData.msgList[0].msgSeq),
    };
    return this.context.session.getGroupService().addGroupEssence(param);
  }

  async kickMemberV2Inner (param: KickMemberV2Req) {
    return this.context.session.getGroupService().kickMemberV2(param);
  }

  async deleteGroupBulletin (groupCode: string, noticeId: string) {
    const psKey = await this.getQunPskey();
    return this.context.session.getGroupService().deleteGroupBulletin(groupCode, psKey, noticeId);
  }

  async quitGroupV2 (GroupCode: string, needDeleteLocalMsg: boolean) {
    const param = {
      groupCode: GroupCode,
      needDeleteLocalMsg,
    };
    return this.context.session.getGroupService().quitGroupV2(param);
  }

  async removeGroupEssenceBySeq (groupCode: string, msgRandom: string, msgSeq: string) {
    const param = {
      groupCode,
      msgRandom: parseInt(msgRandom),
      msgSeq: parseInt(msgSeq),
    };
    return this.context.session.getGroupService().removeGroupEssence(param);
  }

  async removeGroupEssence (groupCode: string, msgId: string) {
    const MsgData = await this.context.session.getMsgService().getMsgsIncludeSelf({
      chatType: 2,
      guildId: '',
      peerUid: groupCode,
    }, msgId, 1, false);
    if (!MsgData.msgList[0]) {
      throw new Error('消息不存在');
    }
    const param = {
      groupCode,
      msgRandom: parseInt(MsgData.msgList[0].msgRandom),
      msgSeq: parseInt(MsgData.msgList[0].msgSeq),
    };
    return this.context.session.getGroupService().removeGroupEssence(param);
  }

  async getSingleScreenNotifies (doubt: boolean, count: number) {
    const [, , , notifies] = await this.core.eventWrapper.callNormalEventV2(
      'NodeIKernelGroupService/getSingleScreenNotifies',
      'NodeIKernelGroupListener/onGroupSingleScreenNotifies',
      [
        doubt,
        '',
        count,
      ]
    );
    return notifies;
  }

  /**
   * 从原始 protobuf 字节中解析 varint
   */
  private static pbDecodeVarint (buf: Buffer, offset: number): [bigint, number] {
    let result = 0n;
    let shift = 0n;
    let pos = offset;
    while (pos < buf.length) {
      const byte = buf[pos++];
      result |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return [result, pos];
      shift += 7n;
    }
    return [result, pos];
  }

  /**
   * 从原始 protobuf 包中提取指定 field 的 bytes 值（只取第一个匹配）
   */
  private static pbExtractField (buf: Buffer, targetField: number): Buffer | null {
    let pos = 0;
    while (pos < buf.length) {
      const [tag, np1] = NTQQGroupApi.pbDecodeVarint(buf, pos);
      pos = np1;
      const fieldNum = Number(tag >> 3n);
      const wireType = Number(tag & 7n);
      if (fieldNum === 0) break;
      if (wireType === 0) {
        const [, np2] = NTQQGroupApi.pbDecodeVarint(buf, pos);
        pos = np2;
      } else if (wireType === 2) {
        const [len, np2] = NTQQGroupApi.pbDecodeVarint(buf, pos);
        pos = np2;
        const data = buf.subarray(pos, pos + Number(len));
        pos += Number(len);
        if (fieldNum === targetField) return Buffer.from(data);
      } else if (wireType === 5) {
        pos += 4;
      } else if (wireType === 1) {
        pos += 8;
      } else {
        break;
      }
    }
    return null;
  }

  /**
   * 从搜索群响应的原始协议包中提取 joinGroupAuth (protobuf field 93)
   * NapCat 的 C++ binding 错误地将 joinGroupAuth 映射到 field 39（始终为空），
   * 实际的 auth token 在 field 93。
   * 路径: OIDB body(f4) → groupInfos item(f4) → detail wrapper(f2) → inner(f1) → auth(f93)
   */
  private extractAuthFromPacket (hexData: string): string {
    try {
      const buf = Buffer.from(hexData, 'hex');
      const body = NTQQGroupApi.pbExtractField(buf, 4);
      if (!body) return '';
      const groupItem = NTQQGroupApi.pbExtractField(body, 4);
      if (!groupItem) return '';
      const detail = NTQQGroupApi.pbExtractField(groupItem, 2);
      if (!detail) return '';
      const inner = NTQQGroupApi.pbExtractField(detail, 1);
      if (!inner) return '';
      const authBuf = NTQQGroupApi.pbExtractField(inner, 93);
      if (!authBuf || authBuf.length === 0) return '';
      return authBuf.toString('utf-8');
    } catch {
      return '';
    }
  }

  async searchGroup (groupCode: string) {
    // Hook 协议包拦截器，从原始 protobuf field 93 提取 joinGroupAuth
    // （NapCat C++ binding 错误映射到 field 39，始终为空）
    const packetHandler = this.context.packetHandler;
    let capturedAuth = '';
    const removeListener = packetHandler.onExact(1, 'OidbSvcTrpcTcp.0x8ba_36', ({ hex_data }) => {
      const auth = this.extractAuthFromPacket(hex_data);
      if (auth) capturedAuth = auth;
    });

    try {
      const [, ret] = await this.core.eventWrapper.callNormalEventV2(
        'NodeIKernelSearchService/searchGroup',
        'NodeIKernelSearchListener/onSearchGroupResult',
        [{
          keyWords: groupCode,
          groupNum: 25,
          exactSearch: false,
          penetrate: '',
        }],
        (ret) => ret.result === 0,
        (params) => !!params.groupInfos.find(g => g.groupCode === groupCode),
        1,
        5000
      );
      const groupInfo = ret.groupInfos.find(g => g.groupCode === groupCode);
      this.context.logger.log(`[searchGroup] groupCode=${groupCode} packetAuth=${capturedAuth ? 'yes' : 'no'}`);
      return groupInfo
        ? { ...groupInfo, packetAuth: capturedAuth }
        : undefined;
    } finally {
      removeListener();
    }
  }

  async activeJoinGroup (groupCode: string, options: {
    comment?: string;
    groupAnswer?: string;
    joinGroupAuth?: string;
    method?: 'req' | 'join';
    search?: boolean;
    serviceType?: number;
    answerMode?: 'both' | 'postscript' | 'group_answer';
  } = {}) {
    const normalizedGroupCode = groupCode.toString();
    const searchGroup = options.search === false
      ? undefined
      : await this.searchGroup(normalizedGroupCode).catch((error) => {
        this.context.logger.logWarn(`activeJoinGroup searchGroup failed: ${error}`);
        return undefined;
      });
    const searchGroupInfo = searchGroup?.searchGroupInfo;
    const groupService = this.context.session.getGroupService();
    const joinInfoCandidates = options.search === false
      ? []
      : await Promise.all([options.serviceType, 1, 111, 0]
          .filter((value, index, array): value is number => typeof value === 'number' && array.indexOf(value) === index)
          .map(async (serviceType) => {
            try {
              const value = await groupService.getGroupInfoForJoinGroup(normalizedGroupCode, true, serviceType) as {
                errCode?: number;
                errMsg?: string;
                result?: Record<string, unknown>;
              };
              return { serviceType, value };
            } catch (error) {
              this.context.logger.logWarn(`activeJoinGroup getGroupInfoForJoinGroup(${serviceType}) failed: ${error}`);
              return undefined;
            }
          }));
    const successfulJoinInfoCandidates = joinInfoCandidates.filter((candidate): candidate is NonNullable<typeof candidate> => candidate?.value?.errCode === 0);
    const selectedJoinInfoCandidate = successfulJoinInfoCandidates
      .slice()
      .sort((left, right) => {
        const score = (candidate: typeof left) => {
          const result = candidate.value.result as {
            groupOption?: number;
            groupQuestion?: string;
            groupAnswer?: string;
            groupFlagExt?: number;
            groupFlagExt3?: number;
            appPrivilegeFlag?: number;
          } | undefined;
          let total = 0;
          if (candidate.serviceType === 1) total += 1000;
          if (candidate.serviceType === 111) total += 100;
          if (candidate.serviceType === options.serviceType) total += 25;
          if ((result?.groupFlagExt3 ?? 0) !== 0) total += 50;
          if ((result?.groupFlagExt ?? 0) !== 0) total += 20;
          if ((result?.groupOption ?? 0) !== 0) total += 10;
          if (result?.groupQuestion) total += 10;
          if (result?.groupAnswer) total += 5;
          if ((result?.appPrivilegeFlag ?? 0) !== 0) total += 5;
          return total;
        };
        return score(right) - score(left);
      })[0];
    const selectedJoinInfo = selectedJoinInfoCandidate?.value as {
      errCode?: number;
      errMsg?: string;
      result?: {
        groupCode?: string;
        groupOption?: number;
        groupQuestion?: string;
        groupAnswer?: string;
        appPrivilegeFlag?: number;
        groupFlagExt?: number;
        groupFlagExt3?: number;
      };
    } | undefined;
    const selectedServiceType = selectedJoinInfoCandidate?.serviceType
      ?? options.serviceType
      ?? 1;
    const joinInfoResult = selectedJoinInfo?.result;
    const resolvedGroupOption = joinInfoResult?.groupOption || searchGroupInfo?.groupOption || 0;
    const resolvedGroupQuestion = joinInfoResult?.groupQuestion || searchGroupInfo?.groupQuestion || '';
    const resolvedGroupFlagExt = joinInfoResult?.groupFlagExt || searchGroupInfo?.groupFlagExt || 0;
    const resolvedGroupFlagExt3 = joinInfoResult?.groupFlagExt3 || searchGroupInfo?.groupFlagExt3 || 0;
    const noVerifyFlag = await Promise.resolve(groupService.getJoinGroupNoVerifyFlag(normalizedGroupCode, selectedServiceType)).catch((error) => {
      this.context.logger.logWarn(`activeJoinGroup getJoinGroupNoVerifyFlag(${selectedServiceType}) failed: ${error}`);
      return undefined;
    }) as { result?: number; errMsg?: string; } | undefined;
    const answer = options.groupAnswer ?? '';
    const qnaFormattedPostscript = resolvedGroupOption === 4 && answer
      ? `问题：${resolvedGroupQuestion}\n答案：${answer}`
      : '';
    const answerMode = options.answerMode ?? (resolvedGroupOption === 4 ? 'both' : 'postscript');
    const resolvedComment = resolvedGroupOption === 4
      ? (options.comment ?? qnaFormattedPostscript)
      : (options.comment || answer || '');
    const postscript = resolvedComment;
    const groupAnswer = answerMode === 'postscript'
      ? ''
      : answer || searchGroupInfo?.groupAnswer || '';
    const resolvedAuth = options.joinGroupAuth
      ?? (searchGroup?.packetAuth || searchGroupInfo?.joinGroupAuth || '');
    // Native joinGroup() reads these exact fields (discovered via Proxy diagnostic):
    // groupCode, sourceId, sourceSubId, richMsg, applyMsg, token, auth, noVerifyAuth, transInfo
    // It does NOT read: groupAnswer, postscript, joinGroupAuth, groupOption, etc.
    const requestPayload = {
      groupCode: normalizedGroupCode,
      sourceId: 0,
      sourceSubId: 0,
      richMsg: '',
      applyMsg: groupAnswer,  // answer goes here - native reads applyMsg, not groupAnswer
      token: '',
      auth: resolvedAuth,
      noVerifyAuth: '',
      transInfo: {},
      // Legacy fields (not read by native joinGroup, but kept for reqToJoinGroup / logging)
      serviceType: selectedServiceType,
      groupOption: resolvedGroupOption,
      groupQuestion: resolvedGroupQuestion,
      appPrivilegeFlag: joinInfoResult?.appPrivilegeFlag ?? 0,
      groupFlagExt: resolvedGroupFlagExt,
      groupFlagExt3: resolvedGroupFlagExt3,
      postscript,
      groupAnswer,
      joinGroupAuth: resolvedAuth,
    };
    const resolvedMethod = options.method ?? (resolvedGroupOption === 4 ? 'join' : 'req');
    const method = resolvedMethod === 'join' ? 'joinGroup' : 'reqToJoinGroup';
    this.context.logger.log(`[activeJoinGroup] method=${method} groupOption=${resolvedGroupOption} auth=${resolvedAuth ? 'yes' : 'no'} answer=${JSON.stringify(requestPayload.applyMsg)}`);

    const callResult = method === 'joinGroup'
      ? await Promise.resolve(groupService.joinGroup(requestPayload))
      : await Promise.resolve(groupService.reqToJoinGroup(requestPayload));

    this.context.logger.log(`[activeJoinGroup] result=${JSON.stringify(callResult)}`);

    return {
      groupCode: normalizedGroupCode,
      method,
      answerMode,
      serviceType: selectedServiceType,
      joinInfo: selectedJoinInfo ?? null,
      noVerifyFlag: noVerifyFlag ?? null,
      callResult,
      requestPayload,
      packetAuth: searchGroup?.packetAuth ?? null,
      searchGroupInfo: searchGroupInfo
        ? {
            groupName: searchGroupInfo.groupName,
            groupOption: searchGroupInfo.groupOption,
            groupQuestion: searchGroupInfo.groupQuestion,
            groupAnswer: searchGroupInfo.groupAnswer,
            joinGroupAuth: searchGroupInfo.joinGroupAuth,
          }
        : undefined,
    };
  }

  async getGroupMemberEx (groupCode: string, uid: string, forced: boolean = false, retry: number = 2) {
    const data = await solveAsyncProblem((eventWrapper: NTEventWrapper, GroupCode: string, uid: string, forced = false) => {
      return eventWrapper.callNormalEventV2(
        'NodeIKernelGroupService/getMemberInfo',
        'NodeIKernelGroupListener/onMemberInfoChange',
        [groupCode, [uid], forced],
        (ret) => ret.result === 0,
        (params: string, _: any, members: Map<string, GroupMember>) => params === GroupCode && members.size > 0 && members.has(uid),
        1,
        forced ? 2500 : 250
      );
    }, this.core.eventWrapper, groupCode, uid, forced);
    if (data && data[3] instanceof Map && data[3].has(uid)) {
      return data[3].get(uid);
    }
    if (retry > 0) {
      const trydata = await this.getGroupMemberEx(groupCode, uid, true, retry - 1) as GroupMember | undefined;
      if (trydata) return trydata;
    }
    return undefined;
  }

  async getGroupFileCount (groupCodes: Array<string>) {
    return this.context.session.getRichMediaService().batchGetGroupFileCount(groupCodes);
  }

  async getArkJsonGroupShare (groupCode: string) {
    const ret = await this.core.eventWrapper.callNoListenerEvent(
      'NodeIKernelGroupService/getGroupRecommendContactArkJson',
      groupCode
    ) as GeneralCallResult & { arkJson: string; };
    return ret.arkJson;
  }

  async uploadGroupBulletinPic (groupCode: string, imageurl: string) {
    const _Pskey = await this.getQunPskey();
    return this.context.session.getGroupService().uploadGroupBulletinPic(groupCode, _Pskey, imageurl);
  }

  async handleGroupRequest (doubt: boolean, notify: GroupNotify, operateType: NTGroupRequestOperateTypes, reason?: string) {
    return this.context.session.getGroupService().operateSysNotify(
      doubt,
      {
        operateType,
        targetMsg: {
          seq: notify.seq,  // 通知序列号
          type: notify.type,
          groupCode: notify.group.groupCode,
          postscript: reason ?? ' ', // 仅传空值可能导致处理失败，故默认给个空格
        },
      });
  }

  async quitGroup (groupCode: string) {
    return this.context.session.getGroupService().quitGroup(groupCode);
  }

  async kickMember (groupCode: string, kickUids: string[], refuseForever: boolean = false, kickReason: string = '') {
    return this.context.session.getGroupService().kickMember(groupCode, kickUids, refuseForever, kickReason);
  }

  async banMember (groupCode: string, memList: Array<{ uid: string, timeStamp: number; }>) {
    // timeStamp为秒数, 0为解除禁言
    return this.context.session.getGroupService().setMemberShutUp(groupCode, memList);
  }

  async banGroup (groupCode: string, shutUp: boolean) {
    return this.context.session.getGroupService().setGroupShutUp(groupCode, shutUp);
  }

  async setMemberCard (groupCode: string, memberUid: string, cardName: string) {
    return this.context.session.getGroupService().modifyMemberCardName(groupCode, memberUid, cardName);
  }

  async setMemberRole (groupCode: string, memberUid: string, role: NTGroupMemberRole) {
    return this.context.session.getGroupService().modifyMemberRole(groupCode, memberUid, role);
  }

  async setGroupName (groupCode: string, groupName: string, isNormalMember: boolean = false) {
    return this.context.session.getGroupService().modifyGroupName(groupCode, groupName, isNormalMember);
  }

  async publishGroupBulletin (groupCode: string, content: string, picInfo: {
    id: string,
    width: number,
    height: number;
  } | undefined = undefined, pinned: number = 0, confirmRequired: number = 0) {
    const psKey = await this.getQunPskey();
    // text是content内容url编码
    const data = {
      text: encodeURI(content),
      picInfo,
      oldFeedsId: '',
      pinned,
      confirmRequired,
    };
    return this.context.session.getGroupService().publishGroupBulletin(groupCode, psKey!, data);
  }

  async getGroupRemainAtTimes (groupCode: string) {
    return this.context.session.getGroupService().getGroupRemainAtTimes(groupCode);
  }

  async getMemberExtInfo (groupCode: string, uin: string) {
    return this.context.session.getGroupService().getMemberExtInfo(
      {
        groupCode,
        sourceType: MemberExtSourceType.TITLETYPE,
        beginUin: '0',
        dataTime: '0',
        uinList: [uin],
        uinNum: '',
        seq: '',
        groupType: '',
        richCardNameVer: '',
        memberExtFilter: {
          memberLevelInfoUin: 1,
          memberLevelInfoPoint: 1,
          memberLevelInfoActiveDay: 1,
          memberLevelInfoLevel: 1,
          memberLevelInfoName: 1,
          levelName: 1,
          dataTime: 1,
          userShowFlag: 1,
          sysShowFlag: 1,
          timeToUpdate: 1,
          nickName: 1,
          specialTitle: 1,
          levelNameNew: 1,
          userShowFlagNew: 1,
          msgNeedField: 1,
          cmdUinFlagExt3Grocery: 1,
          memberIcon: 1,
          memberInfoSeq: 1,
        },
      }
    );
  }
}
