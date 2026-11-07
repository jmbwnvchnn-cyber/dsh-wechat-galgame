'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {loadState}=require('../src/store'),{settleTurn}=require('../src/game'),memory=require('../src/memory');
const root=fs.mkdtempSync(path.join(__dirname,'..','.negative-'));
try {
 let state=loadState(root),seq=0,now=Date.parse('2026-11-03T03:00:00Z');
 const config={positiveCooldownSeconds:0,dailyPositiveCap:1000,repeatWindowHours:0};
 function apply(delta){return settleTurn(state,{groupId:'g',senderId:'u',nickname:'甲',messageId:String(++seq),text:'有效表达'+seq},'回应',delta,'原因',{config,now:now++});}
 assert.equal(apply(-5).score,-5);
 assert.equal(memory.stage(-1),'疏远');assert.equal(memory.stage(-20),'戒备');assert.equal(memory.stage(-60),'反感');
 assert.equal(memory.stage(0),'初识');assert.equal(memory.stage(100),'攻略成功');
 for(let i=0;i<25;i++)apply(-5);assert.equal(state.routes['["g","u"]'].score,-100);
 state=loadState(root);assert.equal(state.routes['["g","u"]'].score,-100);
 assert.equal(apply(5).score,-95,'relationships can recover');
 assert.match(memory.attitude(-80),/反感|疏远|戒备/);assert.match(memory.attitude(85),/亲近|心动|信任/);
 assert.notEqual(memory.attitude(-80),memory.attitude(85));
 console.log('负好感验证通过：下限、存档、恢复、阶段和态度。');
}finally{fs.rmSync(root,{recursive:true,force:true});}
