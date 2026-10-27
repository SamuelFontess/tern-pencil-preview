/**
 * Ends an owner that no window asks for any more: the window it served closed with Tern, crashed, or never came back
 * after a reload. `idle_ms` says how long ago a window last asked; past `limit_ms` the owner is asked to end through
 * `on_expired`, once. A beat that comes much later than `check_ms` means the whole machine was suspended, not that the
 * window went away (it could not ask either): that beat only renews the lease.
 * @param {{idle_ms:()=>number,renew:()=>void,limit_ms:number,check_ms:number,on_expired:()=>void,now?:()=>number,schedule?:Function,cancel?:Function}} options
 * @returns {()=>void} stops the watch
 */
export function watchOrphan({idle_ms,renew,limit_ms,check_ms,on_expired,now=Date.now,schedule=setInterval,cancel=clearInterval}) {
	let last=now();
	let stopped=false;
	const timer=schedule(()=>{
		const at=now();
		const suspended=at-last>check_ms*3;
		last=at;
		if (stopped) return;
		if (suspended) {
			renew();
		} else if (idle_ms()>limit_ms) {
			stop();
			on_expired();
		}
	},check_ms);
	timer?.unref?.();
	function stop() {
		if (stopped) return;
		stopped=true;
		cancel(timer);
	}
	return stop;
}
