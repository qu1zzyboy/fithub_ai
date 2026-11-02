---
name: training-framework
description: 训练框架。代码按四站编排，模型每次只做一次判断。
---

# 训练框架

系统头是 `agents/framework/policy.md`。规则卡在 `agents/framework/knowledge/cards.json`，由代码按站、经验档和人群选入这一次调用。

| 站 | 合同 | 产物 |
| --- | --- | --- |
| ① demand-set | stations/demand-set/contract.md | 本周需求集 |
| ② demand-items | stations/demand-items/contract.md | 需求条目 |
| ③ diagnosis | stations/diagnosis/contract.md | 诊断卡 |
| ④ slots | stations/slots/contract.md | 当周 slot |

⑤ 的轮转和 ⑥ 的负荷不在这些合同里。
