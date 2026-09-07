'use strict';
// CloudBase 云函数：返回服务端当前时间戳（毫秒）。
//
// 用途：同步层用它校正各设备的本地时钟偏差（clock skew）。
// 若各设备直接用本地 Date.now() 写 updated_at，时钟偏快的设备会带着"更大的时间戳"
// 把旧数据写上去，在 LWW 合并时覆盖掉其他设备真正更新的新数据。
// 拿到服务端时间后算出偏移量，所有写库时间戳统一走 serverNow()，各设备时间轴即对齐。
//
// 出参：{ t: <epoch ms> }

exports.main = async () => {
    return { t: Date.now() };
};
