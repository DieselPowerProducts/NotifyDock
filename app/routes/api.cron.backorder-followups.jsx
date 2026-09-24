import {json} from "@remix-run/node";
import {authorizeFollowupCron, runBackorderFollowups} from "../backorder-followup.server";

export async function loader({request}) {
  if (!authorizeFollowupCron(request)) return json({error: "Unauthorized"}, {status: 401});
  return json(await runBackorderFollowups(), {headers: {"Cache-Control": "no-store"}});
}
