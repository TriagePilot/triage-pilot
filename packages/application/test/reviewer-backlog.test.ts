import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AnalyticsRepositoryScope, OpenReviewRequest, TrackedPullRequest } from "@triagepilot/contracts";
import { createReviewerBacklogService, type ReviewerBacklogPorts } from "../src/reviewer-backlog.js";
const request = { workspaceId: "w", providerConnectionId: "c", repositoryIds: [] };
function fixture(count = 1) {
  const scope: AnalyticsRepositoryScope = { ...request, externalConnectionId: "installation", repositories: Array.from({length:count}, (_,i)=>({recordId:`r${i}`,repository:{provider:"github",externalId:String(i),owner:"o",name:`n${i}`}})) };
  const pr = (i=0, n=1): TrackedPullRequest => ({ repositoryRecordId:`r${i}`, repository:scope.repositories[i]!.repository, providerConnectionId:"c",changeRequestId:String(n),changeRequestNumber:n });
  const tracked = vi.fn(async () => ({pullRequests:[pr()],knownActors:["@sam"]}));
  const provider = vi.fn(async (_input: Parameters<ReviewerBacklogPorts["listOpenReviewRequests"]>[0]):Promise<OpenReviewRequest[]> => [{changeRequestId:"1",changeRequestNumber:1,requestedActors:["@alex","@alex"]}]);
  const active=vi.fn(async (_scope:AnalyticsRepositoryScope)=>{});
  const ports = {now:()=>new Date(),loadScope:vi.fn(async()=>scope),assertActive:active,readTracked:tracked,listOpenReviewRequests:provider,classifyError:(e:unknown)=> e instanceof Error && e.message === "authority" ? "authority" as const : "provider_unavailable" as const};
  return {scope,pr,tracked,provider,active,ports,service:createReviewerBacklogService(ports)};
}
beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(new Date("2026-11-05T12:00:00Z"));});
afterEach(()=>vi.useRealTimers());
describe("reviewer backlog",()=>{
 it("accepts reordered repository fields from persisted jobs and excludes the current PR", async () => {
  const f = fixture();
  const exclude = f.pr();
  const { name, owner, provider, externalId } = exclude.repository;
  exclude.repository = { name, owner, provider, externalId };
  expect(await f.service.readLoad({ ...request, actors: ["@alex"], exclude })).toMatchObject({
    status: "complete", loads: { "@alex": 0 },
  });
 });
 it("matches tracked repository identities regardless of field order", async () => {
  const f = fixture();
  const tracked = f.pr();
  const { name, owner, provider, externalId } = tracked.repository;
  tracked.repository = { name, owner, provider, externalId };
  f.tracked.mockResolvedValue({ pullRequests: [tracked], knownActors: [] });
  expect((await f.service.readCurrent(request)).pairs).toEqual([{ changeRequest: tracked, actor: "@alex" }]);
 });
 it.each(["provider", "externalId", "owner", "name"] as const)("rejects a changed repository %s", async field => {
  const f = fixture();
  const exclude = f.pr();
  exclude.repository = { ...exclude.repository, [field]: "different" };
  await expect(f.service.readLoad({ ...request, actors: [], exclude })).rejects.toThrow("Backlog exclusion mismatch");
 });
 it("intersects tracked PRs, deduplicates pairs and returns candidate zeroes only on complete data",async()=>{
  const f=fixture(); f.provider.mockResolvedValue([{changeRequestId:"1",changeRequestNumber:1,requestedActors:["@alex","@alex"]},{changeRequestId:"2",changeRequestNumber:2,requestedActors:["@alex"]}]);
  expect((await f.service.readCurrent(request)).pairs).toHaveLength(1);
  expect(await f.service.readLoad({...request,actors:["@alex","@sam"],exclude:f.pr(0,3)})).toMatchObject({status:"complete",loads:{"@alex":1,"@sam":0}});
  expect((await f.service.readLoad({...request,actors:["@alex"],exclude:f.pr()})).loads).toEqual({"@alex":0});
 });
 it("reuses at 59 seconds, refreshes at 60, and refreshes membership on cache hits",async()=>{
  const f=fixture();await f.service.readCurrent(request);vi.advanceTimersByTime(59000);
  f.tracked.mockResolvedValue({pullRequests:[],knownActors:[]});expect((await f.service.readCurrent(request)).pairs).toEqual([]);expect(f.provider).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(1000);await f.service.readCurrent(request);expect(f.provider).toHaveBeenCalledTimes(2);expect(f.tracked).toHaveBeenCalledTimes(3);
 });
 it("does not cache failures and invalidation forces refresh",async()=>{
  const f=fixture();f.provider.mockRejectedValueOnce(new Error("down"));expect((await f.service.readCurrent(request)).status).toBe("unavailable");
  await f.service.readCurrent(request);f.service.invalidate(request);await f.service.readCurrent(request);expect(f.provider).toHaveBeenCalledTimes(3);
 });
 it("revalidates cache authority and preserves issued scope identity",async()=>{
  const f=fixture();await f.service.readCurrent(request);f.active.mockRejectedValue(new Error("authority"));await expect(f.service.readCurrent(request)).rejects.toThrow("authority");
  expect(f.active.mock.calls.every(([scope])=>scope===f.scope)).toBe(true);
 });
 it("bounds stalled scope and tracked reads",async()=>{
  for(const stage of ["loadScope","readTracked"] as const){const f=fixture();f.ports[stage].mockImplementation(()=>new Promise(()=>{}));const pending=f.service.readLoad({...request,actors:[],exclude:f.pr()});await vi.advanceTimersByTimeAsync(10000);expect(await pending).toMatchObject({status:"fallback",loads:{},reason:"timeout"});}
 });
 it("aborts provider at deadline and never caches a late result",async()=>{
  const f=fixture();let resolve!:(value:OpenReviewRequest[])=>void;let signal!:AbortSignal;
  f.provider.mockImplementationOnce(async (input)=>{signal=input.signal;return new Promise(r=>{resolve=r;});});
  const pending=f.service.readLoad({...request,actors:["@alex"],exclude:f.pr(0,3)});await vi.advanceTimersByTimeAsync(10000);expect(await pending).toMatchObject({status:"fallback",loads:{},reason:"timeout"});expect(signal.aborted).toBe(true);resolve([]);await Promise.resolve();await f.service.readCurrent(request);expect(f.provider).toHaveBeenCalledTimes(2);
 });
 it("limits repository concurrency to four and preserves partial coverage",async()=>{
  const f=fixture(6);let running=0,max=0;
  f.provider.mockImplementation(async()=>{running++;max=Math.max(max,running);await new Promise(r=>setTimeout(r,10));running--;if(f.provider.mock.calls.length===6)throw new Error("down");return [];});
  const pending=f.service.readCurrent(request);await vi.advanceTimersByTimeAsync(100);expect((await pending).status).toBe("partial");expect(max).toBe(4);
 });
 it("keeps independent filters while load covers all repositories",async()=>{
  const f=fixture(2);f.tracked.mockResolvedValue({pullRequests:[f.pr(0),f.pr(1)],knownActors:[]});
  expect((await f.service.readCurrent({...request,repositoryIds:["r0"]})).coveredRepositoryIds).toEqual(["r0"]);
  expect((await f.service.readCurrent({...request,repositoryIds:["r1"]})).coveredRepositoryIds).toEqual(["r1"]);
  expect(await f.service.readLoad({...request,actors:["@alex","@sam"],exclude:f.pr(0,3)})).toMatchObject({status:"complete",loads:{"@alex":2,"@sam":0}});
  expect(f.provider).toHaveBeenCalledTimes(2);
 });
 it("rejects scope and exclusion mismatches instead of fallback",async()=>{
  const f=fixture();await expect(f.service.readCurrent({...request,workspaceId:"other"})).rejects.toThrow("mismatch");
  await expect(f.service.readLoad({...request,actors:[],exclude:{...f.pr(),providerConnectionId:"other"}})).rejects.toThrow("mismatch");
  await expect(f.service.readCurrent({...request,repositoryIds:["missing"]})).rejects.toThrow("mismatch");
 });
 it("does not repopulate cache after invalidation during refresh",async()=>{
  const f=fixture();let resolve!:(value:OpenReviewRequest[])=>void;
  f.provider.mockImplementationOnce(()=>new Promise(r=>{resolve=r;}));const pending=f.service.readCurrent(request);
  await vi.advanceTimersByTimeAsync(0);f.service.invalidate(request);resolve([]);await pending;
  await f.service.readCurrent(request);expect(f.provider).toHaveBeenCalledTimes(2);
 });
 it("does not reuse snapshots after reconnect or for another repository identity",async()=>{
  const f=fixture();await f.service.readCurrent(request);f.scope.externalConnectionId="reconnected";
  await f.service.readCurrent(request);f.scope.repositories[0]!.repository.externalId="new-repository";
  await f.service.readCurrent(request);expect(f.provider).toHaveBeenCalledTimes(3);
 });
 it("refresh removes closed and removed requests and accepts zero candidates",async()=>{
  const f=fixture();await f.service.readCurrent(request);f.provider.mockResolvedValue([]);
  expect((await f.service.readCurrent({...request,forceRefresh:true})).pairs).toEqual([]);
  expect(await f.service.readLoad({...request,actors:[],exclude:f.pr()})).toMatchObject({status:"complete",loads:{}});
 });

});
