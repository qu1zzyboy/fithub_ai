把伤病写成维度约束，把评估摘要里已经写明的断点写成进阶方向。

status 为 ok 时字段：

- appliedRuleIds：字符串数组
- constraints：{ joint, dimension }。有伤病时至少一条
- breakpoints：{ direction }。摘要里没有断点就留空数组

材料不够时 status 为 gap，missing 为字符串数组。
