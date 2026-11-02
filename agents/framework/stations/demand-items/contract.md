把需求集写成需求条目。每条只有运动模式和原因。

status 为 ok 时字段：

- appliedRuleIds：字符串数组
- items：{ id, pattern, reason }。pattern 用蹲、铰链、推、拉、核心这类模式词。一条对应需求集里的一个模块

材料不够时 status 为 gap，missing 为字符串数组。
