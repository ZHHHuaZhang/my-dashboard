// 探针：确认 CloudBase 云函数内能否通过上下文 API 拿到登录用户身份。
// 仅用于诊断，跑完可删除。
// 关键对照：
//   - app.auth().getUserInfo()      -> 平台注入的调用者身份（可信）
//   - app.auth().getEndUserInfo()   -> 同上，异步、字段更全（Node SDK >= 2.2.5）
//   - event.userInfo                -> 旧版/小程序注入字段（Web SDK callFunction 通常为空）

exports.main = async (event, context) => {
  const result = { ts: Date.now() };

  // 1) 取得 app 实例（兼容运行时已注入 global.tcb 与 require 两种方式）
  let app = null, appSource = null, appErr = null;
  try {
    if (typeof global.tcb !== 'undefined') {
      app = global.tcb; appSource = 'global.tcb';
    } else {
      const sdk = require('@cloudbase/node-sdk');
      app = sdk.init({}); appSource = '@cloudbase/node-sdk';
    }
  } catch (e) { appErr = String((e && e.message) || e); }
  result.appSource = appSource;
  result.appErr = appErr;

  // 2) 上下文 API：取调用者可信身份
  if (app && app.auth) {
    try {
      result.getUserInfo = app.auth().getUserInfo();
    } catch (e) {
      result.getUserInfoError = String((e && e.message) || e);
    }
    try {
      const r = await app.auth().getEndUserInfo();
      result.getEndUserInfo = (r && r.userInfo) || r;
    } catch (e) {
      result.getEndUserInfoError = String((e && e.message) || e);
    }
  }

  // 3) 对照：event 里到底有什么
  result.eventKeys = Object.keys(event || {});
  result.eventUserInfo = (event && event.userInfo) || null;

  // 4) 环境变量里与身份相关的键
  result.envAuthKeys = Object.keys(process.env || {})
    .filter(k => /AUTH|TCB|UID|TOKEN|ENV|SESSION/i.test(k));

  return result;
};
