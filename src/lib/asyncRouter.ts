import { Router, RequestHandler } from "express";
// Express 4 does not forward rejected promises to the error middleware.
export function asyncRouter() {
  const router = Router();
  for (const verb of ["get", "post"] as const) {
    const register = router[verb].bind(router);
    router[verb] = ((route: string, ...handlers: RequestHandler[]) => register(route, ...handlers.map(handler => ((req, res, next) => {
      try { Promise.resolve(handler(req, res, next)).catch(next); } catch (err) { next(err); }
    }) as RequestHandler))) as typeof router[typeof verb];
  }
  return router;
}
