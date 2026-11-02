import test from "node:test";
import assert from "node:assert/strict";
import {sideQuestionURL} from "./side-question-url.ts";
test("side URLs preserve the selected main segment and pagination",()=>{
 assert.equal(sideQuestionURL("/api/tasks/1/chat?seg=2",30),"/api/tasks/1/chat/side-questions?seg=2&before=30");
 assert.equal(sideQuestionURL("/api/tasks/1/chat?seg=2"),"/api/tasks/1/chat/side-questions?seg=2");
 assert.equal(sideQuestionURL("/api/conversations/3",0),"/api/conversations/3/side-questions?before=0");
});
