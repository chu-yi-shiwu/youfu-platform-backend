# 医院主数据导入模板

配套脚本：`scripts/import-pilot-master.mjs`

## 文件说明

| 文件 | 必填 | 说明 |
| --- | --- | --- |
| `departments.csv` | 是 | 部门；每租户只能有一个 `is_default=true` |
| `locations.csv` | 建议 | 位置字典；code 租户内唯一 |
| `fault_categories.csv` | 建议 | 问题目录；code 租户内唯一 |
| `workers.csv` | 是 | 人员档案；id（工号）租户内唯一；**默认只保留表头，请按医院实际填写** |
| `route_rules.csv` | 建议 | 部门路由规则；`department_code` 必须是本批或现有部门 code |
| `contacts.csv` | 可选 | 联系人/电话簿；按 `remark` 分组整批替换，适合电话台账一次性导入 |

## 部门

```csv
name,code,remark,is_default
总务科,ZW,默认部门,true
维修组,WX,水电/空调/门窗/电梯/网络维修,false
```

- `ZW` 已存在于试点租户，导入会更新名称/备注并设为默认；
- 其他部门会新建；
- 如果医院不用“维修组/保洁组”，改成实际名称和 code，但要同步改 `workers.csv`、`route_rules.csv`。

## 位置

```csv
code,name,category
HOSP-LOC-001,住院部,住院
HOSP-LOC-002,门诊楼,门诊
```

## 问题目录

```csv
code,name,business_type,skill_tags,sort
hosp_water,水管漏水,repair,"[""repair"",""plumbing""]",10
```

- `business_type` 必须是租户已启用的业务类型；不确定就填 `repair`；
- `skill_tags` 支持 JSON 数组或逗号分隔；
- `sort` 越小越靠前。

## 人员（默认只有表头）

示例行：

```csv
id,name,department_code,skill_tags,phone,active
W2001,张师傅,WX,"repair,plumbing",13800000001,true
W2002,李师傅,WX,"repair,electric",13800000002,true
W2003,陈保洁,BJ,cleaning,13800000003,true
W2004,周安保,AB,security,13800000004,true
```

- `id` 是工号，必须唯一；
- `department_code` 必须对应 `departments.csv` 里的 code；
- 只建人员档案，不建登录账号、不改密码；
- 人员登录账号请用「人员 → 一键开通」或在账号管理里单独创建；
- 手机号用于后续短信/通知，可留空。

## 路由规则

```csv
name,priority,department_code,business_type,catalog_code,catalog_name_contains,location_name_contains,description_contains,source,enabled
漏水归维修组,900,WX,,,,,漏水,,true
保洁归保洁组,900,BJ,cleaning,,,,,,true
```

匹配顺序：

1. 显式指定部门；
2. 规则按 `priority` 从高到低，第一条命中；
3. 全不命中 → 默认部门。

规则至少需要一个匹配条件，不能空规则。

## 联系人

```csv
name,phone,email,org,dept,remark
张三,13800000001,,资兴市第一人民医院,后勤设备科,2024电话台账
护士站,3320850,,资兴市第一人民医院,心血管内科,2024电话台账
```

- `name` 必填；`phone` 可留空；
- `email`、`org`、`dept`、`remark` 可留空；
- 导入按 **非空 remark 分组先删后插**：同一 remark 的旧联系人会被整批替换；
  `remark` 为空的行只追加，不触发删除；
- 电话簿类数据建议统一一个 remark（如 `2024电话台账`），重导不会重复堆叠；
- 含真实手机号时，CSV 不要提交到公开仓库。

## 导入步骤

1. 把整个目录上传到服务器，例如 `/tmp/pilot-master-hospital`；
2. 先 dry-run：

```bash
cd /opt/youfu/pilot/backend
PGDATABASE=youfu_pilot ENV_FILE=.env \
  /opt/node16/bin/node import-pilot-master.mjs \
  --tenant=zixing-hospital --dir=/tmp/pilot-master-hospital
```

3. 确认输出数量和错误行为 0；
4. 再执行 apply：

```bash
... --apply
```

5. 到 PC「基础数据」核对部门、位置、目录、人员、部门路由规则。

## 注意

- 默认 `workers.csv` 只有表头，避免把示例人员导入真实租户；
- 试用 dry-run 时目录不存在会直接报错，不会静默成功；
- CSV 建议 UTF-8；脚本会处理 Excel 的 BOM；
- 字段中包含逗号时用双引号包裹，例如 `"repair,plumbing"`；
- `route_rules.csv` 里的 `department_code` 必须是 `departments.csv` 中的 code。
