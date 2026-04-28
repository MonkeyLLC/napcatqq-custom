import { OneBotAction } from '@/napcat-onebot/action/OneBotAction';
import { ActionName } from '@/napcat-onebot/action/router';
import { Static, Type } from '@sinclair/typebox';

const PayloadSchema = Type.Object({
  group_id: Type.String({ description: '群号' }),
});

type PayloadType = Static<typeof PayloadSchema>;

const ReturnSchema = Type.Any({ description: '主动加群调试信息' });

type ReturnType = Static<typeof ReturnSchema>;

export class NCGetJoinGroupDebugInfo extends OneBotAction<PayloadType, ReturnType> {
  override actionName = ActionName.NCGetJoinGroupDebugInfo;
  override payloadSchema = PayloadSchema;
  override returnSchema = ReturnSchema;
  override actionSummary = '获取主动加群调试信息(实验性)';
  override actionDescription = '返回搜索结果和 QQNT 底层入群相关接口的原始返回，用于排查主动申请加群失败原因。';
  override actionTags = ['group-extend', 'experimental'];
  override payloadExample = {
    group_id: '123456789',
  };
  override returnExample = {
    group_id: '123456789',
    search_result: {},
    join_group_info: {},
    join_group_no_verify_flag: {},
  };

  async _handle (payload: PayloadType): Promise<ReturnType> {
    const groupCode = payload.group_id.toString();
    const groupService = this.core.context.session.getGroupService();

    const wrap = async (label: string, fn: () => unknown | Promise<unknown>) => {
      try {
        return { ok: true, value: await fn() };
      } catch (error) {
        return { ok: false, error: `${label}: ${(error as Error).message}` };
      }
    };

    const joinGroupInfoVariants = await Promise.all([
      { needPrivilegeFlag: false, serviceType: 0 },
      { needPrivilegeFlag: true, serviceType: 0 },
      { needPrivilegeFlag: false, serviceType: 1 },
      { needPrivilegeFlag: true, serviceType: 1 },
      { needPrivilegeFlag: false, serviceType: 111 },
      { needPrivilegeFlag: true, serviceType: 111 },
    ].map(async (variant) => ({
      ...variant,
      result: await wrap(
        `getGroupInfoForJoinGroup(${variant.needPrivilegeFlag}, ${variant.serviceType})`,
        async () => await groupService.getGroupInfoForJoinGroup(groupCode, variant.needPrivilegeFlag, variant.serviceType)
      ),
    })));

    const noVerifyFlagVariants = await Promise.all([
      0,
      1,
      111,
    ].map(async (serviceType) => ({
      serviceType,
      result: await wrap(
        `getJoinGroupNoVerifyFlag(${serviceType})`,
        async () => await (groupService.getJoinGroupNoVerifyFlag as (groupCode: string, serviceType: number) => unknown)(groupCode, serviceType)
      ),
    })));

    return {
      group_id: groupCode,
      search_result: await wrap('searchGroup', async () => await this.core.apis.GroupApi.searchGroup(groupCode)),
      join_group_info: await wrap('getGroupInfoForJoinGroup', async () => await groupService.getGroupInfoForJoinGroup(groupCode, true, 0)),
      join_group_no_verify_flag: await wrap('getJoinGroupNoVerifyFlag', async () => await groupService.getJoinGroupNoVerifyFlag(groupCode, 1)),
      join_group_info_variants: joinGroupInfoVariants,
      join_group_no_verify_flag_variants: noVerifyFlagVariants,
    };
  }
}
