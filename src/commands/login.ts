/**
 * `opennote login` — 微信扫码登录，存 token 到 ~/.opennote/weixin/accounts/。
 */

import { addWeixinAllowFrom, loadConfig, resolveWritableConfigPath } from "../config.js";
import { saveAccount } from "../weixin/accounts.js";
import { DEFAULT_BASE_URL } from "../weixin/ilink.js";
import { login } from "../weixin/login.js";

interface LoginOptions {
  configPath?: string;
}

export async function runLogin(options: LoginOptions = {}): Promise<void> {
  const config = loadConfig(options.configPath);
  const baseUrl = config.weixin.baseUrl || DEFAULT_BASE_URL;

  const account = await login(baseUrl);
  saveAccount(account);

  console.log(`\n✅ 微信登录成功，已保存凭证（account ${account.accountId}）。`);

  // 把扫码人的 id 直接写进 opennote.yaml 的 allowFrom，省得手动配。
  if (account.userId) {
    const target = resolveWritableConfigPath(config);
    try {
      const result = addWeixinAllowFrom(target, account.userId);
      if (result === "added") {
        console.log(`已把你的 id（${account.userId}）写进 ${target} 的 weixin.allowFrom，并开启 weixin.enabled。`);
      } else {
        console.log(`你的 id（${account.userId}）已在 ${target} 的白名单里。`);
      }
    } catch (err) {
      console.error(`自动写入 allowFrom 失败（${err instanceof Error ? err.message : String(err)}）。请手动在 opennote.yaml 的 weixin.allowFrom 加：- ${account.userId}`);
    }
  } else {
    console.log("（服务端没返回 ilink_user_id，需要你手动把自己的 id 加进 weixin.allowFrom。）");
  }

  console.log("\n然后运行 opennote serve 开始收消息。");
}
