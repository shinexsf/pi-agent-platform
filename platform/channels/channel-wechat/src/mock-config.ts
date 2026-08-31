/**
 * Dev-time configuration. Set WECHAT_MOCK_QR=1 in your env to bypass the real
 * iLink API and emit a synthetic QR event after 1 second. Useful when you
 * can't reach ilinkai.weixin.qq.com (e.g. outside China, on a CI runner, or
 * before the bot is registered in the iLink platform).
 */
export const WECHAT_MOCK_QR = process.env.WECHAT_MOCK_QR === '1';