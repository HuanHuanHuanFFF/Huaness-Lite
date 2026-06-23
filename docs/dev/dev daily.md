## 6.18
### 新框架
看juya日报听说Vercel出了agent框架,叫eve,在想要不尝试接到项目里,目前正在让codex调研
codex说当前还处于beta版本,接入风险比较大,建议浅拷贝到参考进行分析
已作为参考分析
### log储存方案
当前在考虑SQLite数据库和jsonl文件之间怎么存放,codex建议我先不上数据库,分析了一下各种的,codex主要是把数据库当索引,hermes是以数据库为中心,因为搜索比较多,openclaw是混合的
经过讨论决定先用jsonl进行过度,后期再想hermes重数据库的方案演进,避免频繁改表发生的变化
## 6.21
### 修改event schema
之前的schema缺少一些字段,在参考了其他项目后决定补齐一些
### 上下文压缩
对上下文压缩具体是怎么做的不清楚,正在调研
😅😅😅重点让GPT分析才告诉我之前拉下来的是个壳,替换泄露源码重新分析
#### Claude Code
`boundaryMarker`:标记,后面拼上下文的时候就不要拼完整的了,到哪就行了
`summaryMessages`:由另一个agent生成的窗口总结
`messagesToKeep`:近期的一段原始对话,不丢失最新部分的细节
`attachments`:重新挂回上下文中比较重要的附件,文件内容,skill等等
`hookResults`:外部hook 机制额外塞进来的结果,用于扩展上下文
## 6.22
重构,发现之前已经写成屎山了,先拆一下types.ts 目前已拆分完毕
学了半天语法,`[key]`是取元组所有元素类型,结果通常是联合类型
# 群聊agent核心痛点
分析了一下
- 1. 工具调用应该异步,不应该阻塞消息会话,需要跑多轮的任务应该强制交给子线程去做,不应该阻塞群聊会话,长连接工具也是
  用户: 长时间任务/工具不会阻塞群聊会话,agent依然能对最新的消息及时做出回应并且能及时调整异步执行的任务
  LLM: 我收到了任务,但是我不会自己做,避免阻塞会话,我知道我把任务怎么派出去了,并且能够调整,做完了agent系统保证我能及时知道结果和产生了什么影响,同时在任务执行过程中我继续专注群聊会话
  - A. 这样必须做多agent,设计agent之间怎么通信等等
  - B. 如果群聊会话的工具改为异步调用,不阻塞,那agent loop的核心机制要改,还要调查各LLM供应商是否支持这样的返回
2. 消息多的时候不应该每条消息都拼上下文发给agent,不然这样会导致
   应该设定一个阈值,把几秒的消息一起发给agent,队列不能只在阻塞的时候排队,应该设计一个缓冲层,在消息多的时候,每2~5秒刷出一次,可以设置一个阈值,消息少的时候 应该保持秒回
3. 记忆相关...
### 其他依赖接入
当前应该尽快接入Vercel AI SDK等后续所需的依赖,避免后期接入后重构
## 6.23
几十行TS review了一晚上,全在补课JS基础
今天拆了json-event-log,然后做了下之前的全量review,补了一天基础,还没review完
### Vercel AI SDK调研结果
```
P0 必用：
1. Model Adapter
   用 Vercel AI SDK 统一接 OpenAI / Anthropic / Gemini / OpenAI-compatible / AI Gateway。

2. Streaming Adapter
   用 streamText/fullStream/onStepFinish 捕获模型流式事件

P0 预留：
3. Tool Protocol Adapter
   后续开发tool模块的时候再考虑

P1+ 再看：
4. Structured output
5. MCP
6. AI SDK UI
7. Memory / embedding / rerank
8. Telemetry / middleware
```
### 异步工具调用
其实我又想了一下,tool call后要即时返回也不是不行,我返回一个任务ID,告诉LLM任务在跑,并且跑完后会通知LLM,同时LLM可以那这个ID,看这个任务的情况,这样就能保证不阻塞群聊会话
