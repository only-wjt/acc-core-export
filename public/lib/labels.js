// 状态与错误分类的展示文案。分类键与 server/error-classify.js 保持一致。

const statusLabels = {
  pending: '等待',
  running: '处理中',
  success: '成功',
  failed: '失败',
  cancelled: '已取消',
  interrupted: '已中断',
};

const errorCategories = {
  region: { label: '地区不支持', advice: 'OpenAI 不支持该出口地区（如香港）。请把代理出口换到受支持地区，换代理重试' },
  password: { label: '密码错误', advice: '请核对账号密码后重试' },
  otp: { label: '验证码', advice: '多为邮箱密码有误或取码超时，请检查邮箱可用性' },
  risk: { label: '风控', advice: '建议降低并发并稍后重试' },
  proxy: { label: '代理/网络', advice: '建议更换代理池后重试' },
  session: { label: 'Session', advice: 'Session 无效时会自动用邮箱重新登录；若仍失败请换代理后重试' },
  ineligible: { label: '不可设密', advice: 'OpenAI 拒绝给该号设置密码，重试通常无效' },
  interrupted: { label: '已中断', advice: '服务重启导致任务中断，请重新发起这些账号' },
  unknown: { label: '未知', advice: '可先重试，若持续失败请检查代理与账号' },
};

export {
  statusLabels,
  errorCategories,
};
