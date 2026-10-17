# 汕头大学统一身份认证 (CAS SSO) 联调工具

[![Node.js Version](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Zero Dependencies](https://img.shields.io/badge/dependencies-0-success.svg)](#)

本项目是一个专为**汕头大学统一身份认证（CAS 协议）**设计的端到端最小化联调与冒烟测试工具。

**核心特色：**
- **零外部依赖**：基于 Node.js 原生标准库（`node:http`、`node:crypto`、`node:url`）开发，无需执行 `npm install`，开箱即用。
- **纯粹与安全**：仅完成“浏览器重定向 -> 接收 CAS 票据 -> 后端验票 -> 展示响应”的最小闭环；不收集用户密码、不建立本地账号、不签发业务会话。
- **高安全标准**：内置防 Login-CSRF（双重 State 比对）、防时序攻击（Timing-safe comparison）、防重放（一次性作废）、请求超时与大响应内存保护。
- **开箱即测**：内置本地 Mock CAS 验证测试套件，即使在断网或未获得学校授权的环境下也可直接运行完整自测。

---

## 一、 快速开始

### 1. 环境准备
确保本机安装了 **Node.js 20** 或更高版本：
```bash
node -v
```

### 2. 本地自测（无需连网）
运行内置的 Mock 模拟测试套件，验证全部安全规则与 CAS 协议链路：
```bash
npm test
```

### 3. 启动联调服务
```bash
npm start
```
默认会在本地启动服务：<http://127.0.0.1:3000>。

---

## 二、 交互时序与工作原理

```text
[用户浏览器]                         [本联调工具 (CAS Client)]               [汕大 SSO (sso.stu.edu.cn)]
     |                                      |                                    |
     |---- 1. 访问 /login ----------------->|                                    |
     |                                      | 生成高强度随机 state                |
     |                                      | 记录事务并设置临时 State Cookie    |
     |<--- 2. 302 重定向到学校登录页 --------|                                    |
     |        (参数携带 service 回调地址)   |                                    |
     |                                                                           |
     |---- 3. 浏览器跳转到学校统一认证平台 --------------------------------------->|
     |                                                                           | 用户输入学号密码/MFA
     |<--- 4. 认证成功，302 跳回客户端 -------------------------------------------|
     |        (URL 携带 ?state=...&ticket=ST-xxxx)                               |
     |                                      |                                    |
     |---- 5. 带着 Ticket 请求 /callback -->|                                    |
     |                                      | 校验 State、Cookie、Ticket 格式    |
     |                                      | 立即销毁该次事务（防重放）         |
     |                                      |                                    |
     |                                      |==== 6. 后端直连验票 (Back-channel) =>|
     |                                      |     GET /serviceValidate           |
     |                                      |<=== 7. 返回 XML 结果 ==============|
     |                                      |     (解析用户主体 cas:user)        |
     |                                      |                                    |
     |<--- 8. 页面渲染认证结果与原始 XML ----|                                    |
```

---

## 三、 向学校网络信息中心申请对接指南

要完成真实的汕大 SSO 联调，需要将你的回调地址报备到学校 CAS 服务端白名单中。

### 1. 需要向学校报备的信息
- **系统名称**：例如 `XX学院学生管理系统（测试环境）`
- **公网根域名**：例如 `https://sso-demo.example.edu.cn`
- **完整回调地址**：`https://sso-demo.example.edu.cn/callback`
- **关于参数的说明**：认证发起时实际重定向的 service 为 `https://sso-demo.example.edu.cn/callback?state=随机防伪值`。请与网络中心老师确认学校 CAS 是否支持带查询参数的匹配，或者是否支持通配符/前缀匹配。

### 2. 需要向学校索取的信息
- **正式登录端点（Login URL）**：通常为 `https://sso.stu.edu.cn/login`。
- **正式验票端点（Validate URL）**：
  - CAS 2.0 标准路径通常为：`https://sso.stu.edu.cn/serviceValidate`
  - 若需要获取用户详细属性（如身份证号、学院、身份类型），可能为 CAS 3.0 路径：`https://sso.stu.edu.cn/p3/serviceValidate`

---

## 四、 环境变量与参数配置

在生产联调或接入公网域名时，可以通过环境变量配置各项参数：

| 环境变量名 | 默认值 | 必填 | 说明 |
| :--- | :--- | :---: | :--- |
| `PORT` | `3000` | 否 | 服务监听端口（必须为 0~65535 的整数） |
| `HOST` | `127.0.0.1` | 否 | 服务绑定的主机地址（若需外部访问可设为 `0.0.0.0`） |
| `PUBLIC_BASE_URL` | *(空)* | **实测必填** | 学校登记的**公网根域名**（例如 `https://sso-demo.example.edu.cn`），必须为 HTTPS 根地址，不可含子路径 |
| `CAS_LOGIN_URL` | `https://sso.stu.edu.cn/login` | 否 | 汕大统一认证登录页地址 |
| `CAS_VALIDATE_URL` | `https://sso.stu.edu.cn/serviceValidate` | 否 | 汕大统一认证验票接口地址 |
| `ALLOW_INSECURE_LOCAL_TEST` | `0` | 否 | 仅在本地单测回环（127.0.0.1）允许 HTTP，设为 `1` 开启 |

### 启动示例（PowerShell）
```powershell
$env:PUBLIC_BASE_URL = "https://sso-demo.example.edu.cn"
$env:CAS_LOGIN_URL = "https://sso.stu.edu.cn/login"
$env:CAS_VALIDATE_URL = "https://sso.stu.edu.cn/serviceValidate"
npm start
```

### 启动示例（Linux / macOS Bash）
```bash
PUBLIC_BASE_URL="https://sso-demo.example.edu.cn" \
CAS_LOGIN_URL="https://sso.stu.edu.cn/login" \
CAS_VALIDATE_URL="https://sso.stu.edu.cn/serviceValidate" \
npm start
```

也可参考 [`.env.example`](.env.example) 维护本地环境配置。

---

## 五、 联调结果排查（FAQ）

| 现象 / 提示 | 原因分析 | 解决办法 |
| :--- | :--- | :--- |
| **跳转学校后提示“未注册的 service”或“非法服务”** | 学校 CAS 端未将你的 `PUBLIC_BASE_URL/callback` 加入白名单。 | 确认实际跳转 URL 中的 `service` 参数值，向学校网络中心提交工单报备登记该地址。 |
| **回调提示“缺少有效的一次性登录事务或 State 匹配失败”** | 1. 登录超时（超过 5 分钟）；<br>2. 跨域/反向代理导致 Cookie 丢失；<br>3. 刷新了已消费过的回调页面。 | 返回首页重新点击“跳转汕大统一登录”；检查反向代理是否透传了 Cookie 与 Host。 |
| **验票接口返回 HTTP 404** | 验票端点路径不正确。 | 默认的 `/serviceValidate` 是推测路径，请向网络中心确认真实的 CAS 2.0/3.0 验票端点。 |
| **验票返回 `authenticationFailure (INVALID_TICKET)`** | 1. 票据已被使用过（CAS 票据仅能消费一次）；<br>2. 票据已过期；<br>3. 验票时传入的 `service` 与登录时**不完全一致**。 | 确保验票时的 `service`（包括查询参数）与跳转时的完全相同；每次测试均从首页重新发起。 |
| **验票返回 `authenticationSuccess`** | **恭喜，CAS 协议核心链路完全通畅！** | 页面会直接高亮显示解析出的 `<cas:user>`（学号/工号），并列出完整的原始 XML 报文。 |

---

## 六、 迈向正式生产系统的改造建议

本工具通过验证后，在正式业务系统中接入 SSO 仅需补齐以下环节：
1. **XML 实体解析与属性提取**：使用可靠的 XML 解析库（推荐禁用外部实体解析 XXE），提取 `<cas:user>` 及其属性（如姓名、部门、邮箱等）。
2. **账号映射与自动建档**：以学号/工号为主键，查询本地数据库；若不存在则自动初始化本地用户档案。
3. **颁发业务系统凭证**：向前端下发你系统自身的 Session Cookie 或 JWT Token。
4. **单点登出（SLO）对接**：如需支持全局退出，可在用户点击注销时重定向至 `https://sso.stu.edu.cn/logout`。

---

## 七、 许可证

[MIT License](LICENSE)
