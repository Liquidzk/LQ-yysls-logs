"""Build Boss membership from exact entity tag references in decoded config."""
import argparse,json
from pathlib import Path

def build(doc):
 rows=lambda table:doc.get(table,{}).get('rows',{})
 def tags(table,ident):
  v=rows(table).get(str(ident),{}).get('values',{})
  return set(x for x in [v.get('base_tag_str'),*v.get('addition_tags',[])] if isinstance(x,str))
 result={}
 for ident,row in rows('entity').items():
  v=row.get('values',{});base=v.get('base_tag');found=tags('entity_tags',base)
  additional=v.get('gameplay_tag',[])
  if not isinstance(additional,list):additional=[additional]
  for tag in additional:found|=tags('entity_additional_tags',tag)
  if 'TAG_BOSS_MONSTER' in found:
   result[ident]={'basis':'entity-tags','baseTag':base,'additionalTags':additional}
 # Exact UI pair: boss_dr_clk_misc.DEFAULT_SOUL_BOSS_ENTITY_NO and
 # fuben_info fight_entity_id / spaces.s140001.entity. See evidence document.
 for ident,role in [('22800004','body'),('22800007','soul')]:
  result.setdefault(ident,{'basis':'choulingke-dual-blood-controller'})
  result[ident].update(group='choulingke',role=role)
 return {'version':1,'build':'cn-win64r-20261023','entities':result,
         'groups':{'choulingke':{'name':'愁铃客','members':{'22800004':'肉体','22800007':'灵魂'}}}}

if __name__=='__main__':
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--rows',type=Path,required=True);p.add_argument('--output',type=Path,required=True);a=p.parse_args()
 out=build(json.loads(a.rows.read_text('utf-8')));a.output.write_text(json.dumps(out,ensure_ascii=False,separators=(',',':')),'utf-8');print('Boss templates:',len(out['entities']))
