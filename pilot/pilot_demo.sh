#!/usr/bin/env bash
# 试点闭环演示：对 4100(AUTO_TUNE) 跑 过程挖掘→生成优化→改写流程定义→核查
B=http://127.0.0.1:4100
H1="Authorization: Bearer dev"
H2="X-Tenant-Id: t-verification"

curl -s -H "$H1" -H "$H2" "$B/api/v1/process-mining?days=30" -o /tmp/mining.json
curl -s -X POST -H "$H1" -H "$H2" "$B/api/v1/optimize/generate-mining?entityType=work_order&days=30" -o /tmp/gen.json
curl -s -H "$H1" -H "$H2" "$B/api/v1/workflow/def?entity=work_order" -o /tmp/def_after.json
curl -s -H "$H1" -H "$H2" "$B/api/v1/optimize/list" -o /tmp/list.json

node -e '
const m=require("/tmp/mining.json").result;
console.log("MINING cases="+m.overview.case_count+" events="+m.overview.event_count);
console.log("  slowest_edge="+JSON.stringify(m.bottlenecks.slowest_edge));
console.log("  deviation="+m.conformance.deviation_rate);
console.log("  variants="+JSON.stringify(m.variants.map(v=>[v.seq.join(">"),v.count])));
const g=require("/tmp/gen.json");
console.log("GEN applied="+g.applied+" targets="+JSON.stringify((g.generated||[]).map(d=>d.target)));
const d=require("/tmp/def_after.json").def;
console.log("DEF states="+JSON.stringify(d.states)+" n_transitions="+d.transitions.length+" config="+JSON.stringify(d.config));
const l=require("/tmp/list.json");
console.log("LIST total="+l.items.length+" applied="+l.items.filter(i=>i.status==="applied").length);
'
