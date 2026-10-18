import json,sys
for l in sys.stdin:
  try: r=json.loads(l)
  except: print(l.rstrip()); continue
  print(r['browser'].ljust(13), r.get('url','')[8:48].ljust(41), 'req',str(r.get('requests')).rjust(4),'blk',str(r.get('blocked')).rjust(3),'ext',str(r.get('redirectedToExtension')).rjust(2),'ads',r.get('adSlotsVisible'),'/',r.get('adSlotsTotal'),'detect',r.get('adblockDetectedText'), 'load',r.get('loadMs'), r.get('error',''))
