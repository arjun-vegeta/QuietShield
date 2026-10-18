"""Offline replica of Chrome DNR's regex validation (extensions/browser/api/declarative_net_request:
RE2 with max_mem = 2 KiB, Latin-1, never_capture). Usage: re2check.py <in.json [{regex,cs}]> -> prints JSON list."""
import json, sys, re2
def check(regex, cs, mem_kb=2):
    o = re2.Options(); o.case_sensitive = cs; o.max_mem = mem_kb << 10; o.log_errors = False
    o.never_capture = True; o.encoding = re2.Options.Encoding.LATIN1
    try:
        r = re2.compile(regex.encode("latin-1"), o)
        return {"isSupported": True}
    except re2.error as e:
        msg = str(e)
        return {"isSupported": False, "reason": "memoryLimitExceeded" if "too large" in msg or "too big" in msg or "out of memory" in msg.lower() else "syntaxError", "msg": msg}
if __name__ == "__main__":
    items = json.load(open(sys.argv[1]))
    json.dump([check(i["regex"], bool(i.get("cs"))) for i in items], sys.stdout)
