把需求条目装成当周 session，并为每个 slot 选一个候选动作。

status 为 ok 时字段：

- appliedRuleIds：字符串数组
- sessions：整数，不超过案卷里的 frequency
- slots：{ slotId, session, pattern, anchor, patternFamily, constraints, role, movementId 或 unfilledReason }
  session 从 1 起。有合适候选才填 movementId。没有就写 unfilledReason，不要编 id
  同一课的动作数不要超过案卷里的 movementsPerSession 上限

session 数超过频率时不要硬排。status 为 return，to 为 demand-set，reasonTag 为「恢复不足」。

材料不够时 status 为 gap，missing 为字符串数组。
