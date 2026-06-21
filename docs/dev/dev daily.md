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
