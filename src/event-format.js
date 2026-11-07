'use strict';
function text(value,max){return typeof value==='string'&&value.trim()&&value.length<=max;}
function choices(value){
  if(!Array.isArray(value)||value.length!==3||value.some(o=>!o||!text(o.text,240)||!text(o.reply,400)||!Number.isInteger(o.delta)||o.delta < -3||o.delta > 3))return null;
  return value.map(o=>({text:o.text.trim(),reply:o.reply.trim(),delta:o.delta}));
}
function draft(value){
  if(!value||!text(value.title,80)||!text(value.text,800))return null;
  const options=choices(value.options);return options?{title:value.title.trim(),text:value.text.trim(),options}:null;
}
function storedChoices(value){return Boolean(choices(value)&&new Set(value.map(o=>o.label)).size===3&&value.every(o=>['A','B','C'].includes(o.label)));}
module.exports={choices,draft,storedChoices};
