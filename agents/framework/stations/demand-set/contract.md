判断本周需求集：主模块、维持、调味，以及各自占比。不排课次，不写动作。

案卷里若有 bounceReason，收紧需求集，不要增加课次。

status 为 ok 时字段：

- appliedRuleIds：字符串数组
- phase：这段训练机会的侧重，一个短名称
- periodization：linear 或 undulating，按规则卡
- items：{ id, role, module, share }。role 只能是 primary、maintain、flavor。primary 的 share 合计在 60 到 70。全部 share 合计为 100

材料不够时 status 为 gap，missing 为字符串数组。
