import assert from 'node:assert/strict';
import test from 'node:test';
import {watchOrphan} from '../src/orphan.mjs';

/** A clock and an interval the test turns by hand. */
function clock() {
	const state={time:0,fn:null,cleared:false};
	return {
		state,
		now:()=>state.time,
		schedule:(fn)=>{ state.fn=fn; return 7; },
		cancel:id=>{ if (id===7) state.cleared=true; },
		advance(ms,{beats=1}={}) {
			state.time+=ms;
			for (let index=0;index<beats;index+=1) state.fn();
		},
	};
}

function watch(options={}) {
	const time=clock();
	const log={expired:0,renewed:0,idle:0};
	const stop=watchOrphan({
		idle_ms:()=>log.idle,renew:()=>{ log.renewed+=1; log.idle=0; },limit_ms:120000,check_ms:5000,
		on_expired:()=>{ log.expired+=1; },now:time.now,schedule:time.schedule,cancel:time.cancel,...options,
	});
	return {time,log,stop};
}

test('an owner no window has asked for longer than the limit ends, once',()=>{
	const {time,log}=watch();
	for (let index=0;index<24;index+=1) {
		time.advance(5000);
		log.idle+=5000;
	}
	assert.equal(log.expired,0,'exactly at the limit is not past it');
	time.advance(5000);
	log.idle+=5000;
	time.state.fn();
	assert.equal(log.expired,1);
	assert.equal(time.state.cleared,true,'it stops watching once it asked the owner to end');
});

test('a window that keeps asking keeps the owner for ever',()=>{
	const {time,log}=watch();
	for (let index=0;index<1000;index+=1) {
		time.advance(5000);
		log.idle=1000;
	}
	assert.equal(log.expired,0);
});

test('a machine that slept is not an absent window: the first beat after a long gap only renews the lease',()=>{
	const {time,log}=watch();
	log.idle=119000;
	time.advance(3600000);
	assert.equal(log.expired,0);
	assert.equal(log.renewed,1);
	assert.equal(log.idle,0);
	time.advance(5000);
	assert.equal(log.expired,0,'and the window has the whole limit again');
});

test('stopping the watch ends the interval',()=>{
	const {time,stop}=watch();
	stop();
	assert.equal(time.state.cleared,true);
});
