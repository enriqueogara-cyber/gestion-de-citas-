import test from "node:test";
import assert from "node:assert/strict";
import { rateLimit } from "../lib/rateLimit";

function fakeReqRes(ip: string, path = "/x") {
  const req: any = { ip, baseUrl: "", path };
  let statusCode = 200;
  let jsonBody: unknown = null;
  const res: any = {
    setHeader: () => {},
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(body: unknown) {
      jsonBody = body;
      return this;
    },
  };
  return { req, res, getStatus: () => statusCode, getJson: () => jsonBody };
}

test("rateLimit: dentro del límite, deja pasar y llama a next()", () => {
  const mw = rateLimit({ windowMs: 60_000, max: 3 });
  const { req, res } = fakeReqRes("1.2.3.4", "/a");
  let nextCalled = 0;
  mw(req, res, () => { nextCalled += 1; });
  assert.equal(nextCalled, 1);
});

test("rateLimit: al superar el máximo, responde 429 y NO llama a next()", () => {
  const mw = rateLimit({ windowMs: 60_000, max: 2 });
  const { req, res, getStatus } = fakeReqRes("5.6.7.8", "/b");
  let nextCalled = 0;
  const next = () => { nextCalled += 1; };

  mw(req, res, next); // 1
  mw(req, res, next); // 2
  mw(req, res, next); // 3 — debería bloquearse

  assert.equal(nextCalled, 2);
  assert.equal(getStatus(), 429);
});

test("rateLimit: IPs distintas no comparten cupo", () => {
  const mw = rateLimit({ windowMs: 60_000, max: 1 });
  const a = fakeReqRes("10.0.0.1", "/c");
  const b = fakeReqRes("10.0.0.2", "/c");
  let nextCalled = 0;
  const next = () => { nextCalled += 1; };

  mw(a.req, a.res, next);
  mw(b.req, b.res, next);

  assert.equal(nextCalled, 2, "cada IP tiene su propio cupo");
});

test("rateLimit: rutas distintas no comparten cupo", () => {
  const mw = rateLimit({ windowMs: 60_000, max: 1 });
  const onA = fakeReqRes("9.9.9.9", "/route-a");
  const onB = fakeReqRes("9.9.9.9", "/route-b");
  let nextCalled = 0;
  const next = () => { nextCalled += 1; };

  mw(onA.req, onA.res, next);
  mw(onB.req, onB.res, next);

  assert.equal(nextCalled, 2);
});

test("rateLimit: con RATE_LIMIT_DISABLED=1, nunca bloquea", () => {
  const prev = process.env.RATE_LIMIT_DISABLED;
  process.env.RATE_LIMIT_DISABLED = "1";
  try {
    const mw = rateLimit({ windowMs: 60_000, max: 1 });
    const { req, res } = fakeReqRes("1.1.1.1", "/d");
    let nextCalled = 0;
    const next = () => { nextCalled += 1; };
    for (let i = 0; i < 5; i++) mw(req, res, next);
    assert.equal(nextCalled, 5);
  } finally {
    if (prev === undefined) delete process.env.RATE_LIMIT_DISABLED;
    else process.env.RATE_LIMIT_DISABLED = prev;
  }
});
