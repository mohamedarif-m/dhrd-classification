"""Token cache: 80%-TTL refresh, single-flight mint, 401 invalidation."""

import asyncio

from app.services.token_service import TokenService


class Clock:
    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t


def make_service(clock, delay=0.0):
    counter = {"n": 0}

    async def mint():
        counter["n"] += 1
        if delay:
            await asyncio.sleep(delay)
        return f"tok-{counter['n']}", 3600.0

    svc = TokenService("unused-key", mint=mint, now=clock)
    return svc, counter


def test_caches_until_80pct_ttl():
    clock = Clock()
    svc, counter = make_service(clock)

    async def scenario():
        t1 = await svc.get()
        t2 = await svc.get()
        assert t1 == t2 == "tok-1"
        clock.t += 0.79 * 3600  # just inside the fresh window
        assert await svc.get() == "tok-1"
        clock.t += 0.02 * 3600  # crosses 80% of TTL
        assert await svc.get() == "tok-2"
        assert counter["n"] == 2

    asyncio.run(scenario())


def test_single_flight_concurrent_mints_once():
    clock = Clock()
    svc, counter = make_service(clock, delay=0.05)

    async def scenario():
        tokens = await asyncio.gather(*[svc.get() for _ in range(8)])
        assert set(tokens) == {"tok-1"}
        assert counter["n"] == 1

    asyncio.run(scenario())


def test_invalidate_forces_fresh_mint():
    clock = Clock()
    svc, counter = make_service(clock)

    async def scenario():
        assert await svc.get() == "tok-1"
        svc.invalidate()  # what the client does on an upstream 401
        assert await svc.get() == "tok-2"
        assert counter["n"] == 2

    asyncio.run(scenario())
