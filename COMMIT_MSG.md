test: 补生成服务端到端测试，并修掉它抓到的两个真缺陷

新增 test/generate-service.test.ts：把「发消息」这条完整链路真的跑一遍
（组装 → 计数 → 解密 Key → 构造请求体 → 流式 → 落库 → 推事件）。
在此之前它是靠 streamChat 与 assemble 的**分段**测试拼出来的，
而编排本身（beginGeneration + runStream）从未被验证过——
属于「分开测都过、合起来不对」的典型。三处外部依赖都被注入替换
（safeStorage 用 vi.mock、fetch 用录制 SSE、DB 用 node:sqlite 内存驱动），
不发真实网络请求，也不出现真实密钥。

它抓到并修掉了两个真问题：

1. 被取代的流会覆盖新流的结果（并发缺陷）
   同一会话再次发送时，新流先 abort 旧流，但旧流仍会走完收尾，
   把自己的残留内容 + interrupted 状态写回去，覆盖掉新一次生成的结果。
   修法：runStream 里加 isCurrent() 判断，被取代后一切写操作放弃。

2. 被取代的流会留下永远「生成中」的消息行
   上一条的连带问题：放弃写操作后，那一行就停在 streaming 不动了——
   正是产品设计文档 7 验收项 10 明令禁止的残留状态。
   修法：被取代时把自己的消息行删掉（那半截回答没有保留价值），
   并断言全库不再有 streaming 行。

顺带把测试里的等待从固定 sleep 改成轮询 waitFor：
beginGeneration 是「启动即返回」的设计，固定 sleep 会写出
「快机器上过、慢机器上挂」的测试。

验证：测试 400 项全绿（vitest 329 + node --test 71），typecheck 干净，
4 份校验全过，三段构建成功，smoke:dev 通过。
