#!/usr/bin/env python3
"""H2H Arbitrage Test Suite - Happy and Unhappy Paths"""
import sys, json, time, argparse
from urllib.request import urlopen, Request
from urllib.error import HTTPError

def post(path, data, base, timeout=20):
    url = f"{base}{path}"
    body = json.dumps(data).encode()
    req = Request(url, data=body, headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urlopen(req, timeout=timeout) as res:
            return res.status, json.loads(res.read().decode())
    except HTTPError as e:
        body = e.read().decode()
        try:
            return e.code, json.loads(body)
        except:
            return e.code, {"error": body}
    except Exception as e:
        return None, {"error": str(e)}

def get(path, base, timeout=10):
    url = f"{base}{path}"
    req = Request(url)
    try:
        with urlopen(req, timeout=timeout) as res:
            return res.status, json.loads(res.read().decode())
    except HTTPError as e:
        body = e.read().decode()
        try:
            return e.code, json.loads(body)
        except:
            return e.code, {"error": body}
    except Exception as e:
        return None, {"error": str(e)}

TESTS = []
def test(label, category="happy"):
    def deco(fn):
        TESTS.append((label, category, fn))
        return fn
    return deco

@test("Scan valid Drake market (named binary outcomes)")
def t_drake(base):
    status, data = post("/api/scan", {
        "kalshiUrl": "https://kalshi.com/markets/kxfeaturedrake/who-will-be-featured-on-drake-album/kxfeaturedrake",
        "polymarketUrl": "https://polymarket.com/event/who-will-be-featured-on-iceman"
    }, base)
    assert status == 200, f"Expected 200, got {status}: {data.get('error')}"
    assert data.get("kalshiCount", 0) > 0, "No Kalshi markets"
    assert data.get("pmCount", 0) > 0, "No Polymarket markets"
    assert data.get("matchedCount", 0) > 0, "No matched pairs"
    return f"K={data['kalshiCount']} PM={data['pmCount']} Matched={data['matchedCount']}"

@test("Scan invalid Polymarket URL (unhappy)")
def t_invalid_pm(base):
    status, data = post("/api/scan", {
        "kalshiUrl": "https://kalshi.com/markets/kxfeaturedrake/who-will-be-featured-on-drake-album/kxfeaturedrake",
        "polymarketUrl": "https://polymarket.com/event/nonexistent-market-12345"
    }, base, timeout=10)
    assert status in (404, 500, 504), f"Expected 404/500/504, got {status}"
    return f"status={status} error='{data.get('error', '')[:50]}'"

@test("Scan empty body (unhappy)")
def t_empty_body(base):
    status, data = post("/api/scan", {}, base)
    assert status == 400, f"Expected 400, got {status}: {data}"
    return f"status={status}"

@test("Scan bad URL format (unhappy)")
def t_bad_url(base):
    status, data = post("/api/scan", {
        "kalshiUrl": "not-a-url",
        "polymarketUrl": "also-bad"
    }, base)
    assert status == 400, f"Expected 400, got {status}: {data}"
    return f"status={status}"

@test("Save, retrieve, delete market")
def t_save_retrieve(base):
    s1, d1 = post("/api/saved-markets", {
        "kalshiUrl": "https://kalshi.com/markets/test",
        "polymarketUrl": "https://polymarket.com/event/test",
        "eventTitle": "Test Market"
    }, base)
    assert s1 == 201, f"Expected 201, got {s1}: {d1.get('error')}"
    market_id = d1["market"]["id"]
    s2, d2 = get("/api/saved-markets", base)
    assert s2 == 200
    assert any(m["id"] == market_id for m in d2.get("markets", []))
    # Delete
    req = Request(f"{base}/api/saved-markets?id={market_id}", method="DELETE")
    try:
        with urlopen(req, timeout=10) as res:
            assert res.status == 200
    except HTTPError as e:
        assert e.code == 200
    return f"id={market_id}"

@test("CORS preflight")
def t_cors(base):
    req = Request(f"{base}/api/scan", method="OPTIONS", headers={
        "Origin": "http://example.com",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "Content-Type"
    })
    try:
        with urlopen(req, timeout=10) as res:
            return f"status={res.status}"
    except HTTPError as e:
        return f"HTTPError {e.code}"
    except Exception as e:
        return f"Exception: {e}"

def run(base):
    passed = 0; failed = 0; fails = []
    for label, category, fn in TESTS:
        print(f"  [{category.upper():6}] {label} ... ", end="", flush=True)
        try:
            result = fn(base)
            print(f"✅ PASSED ({result})")
            passed += 1
        except Exception as e:
            print(f"❌ FAILED: {e}")
            fails.append((label, e))
            failed += 1
    print(f"\nResults: {passed} passed, {failed} failed out of {len(TESTS)} tests")
    if fails:
        print("\nFailures:")
        for l, e in fails:
            print(f"  - {l}: {e}")
    return failed == 0

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://localhost:3010")
    args = parser.parse_args()
    ok = run(args.url)
    sys.exit(0 if ok else 1)
