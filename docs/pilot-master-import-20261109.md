# 试点主数据导入（2026-11-09）

脚本：`scripts/import-pilot-master.mjs`
示例目录：`scripts/pilot-master-example/`

## 1. 用法

```bash
cd /opt/youfu/pilot/backend
PGDATABASE=youfu_pilot ENV_FILE=.env \
  /opt/node16/bin/node import-pilot-master.mjs \
  --tenant=zixing-hospital --dir=/tmp/pilot-master
```

默认 **dry-run**：只校验、不写库。确认后加 `--apply`：

```bash
... --apply
```

## 2. CSV 文件

缺失的文件会跳过。

### departments.csv

```csv
name,code,remark,is_default
维修组,HOSP_WX,水电空调门窗维修,false
```

### locations.csv

```csv
code,name,category
HOSP-LOC-001,住院部,住院
```

### fault_categories.csv

`skill_tags` 支持 JSON 数组或逗号分隔：

```csv
code,name,business_type,skill_tags,sort
hosp_water,水管漏水,repair,"[""repair"",""plumbing""]",10
```

### workers.csv

只建人员档案，不建账号、不改密码：

```csv
id,name,department_code,skill_tags,phone,active
W1001,张师傅,HOSP_WX,"repair,plumbing",13800000001,true
```

### route_rules.csv

`department_code` 必须是已存在或同批导入的部门 code；至少一个匹配条件：

```csv
name,priority,department_code,business_type,catalog_code,catalog_name_contains,location_name_contains,description_contains,source,enabled
漏水归维修组,900,HOSP_WX,,,,,漏水,,true
```

## 3. 幂等与安全

- 部门按 `code`、位置按 `code`、目录按 `code`、人员按 `id`、规则按 `name` 覆盖；
- 不删除 CSV 中未出现的数据；
- 不创建账号、不改密码；
- 整个导入在一个事务里，任一行校验失败即回滚；
- 建议先 dry-run，再 apply，最后在 PC 基础数据页核对。

## 4. 示例

`scripts/pilot-master-example/` 提供 3 部门 / 5 位置 / 8 目录 / 6 人员 / 4 规则，
可直接 dry-run 验证格式；不要原样应用到正式租户，请按医院实际修改。
