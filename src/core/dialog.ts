export { Dialog as default }

import { MatchOption, Matcher, Session } from './common';
import { DialogOpener, DialogOpenerProperties } from './dialog-opener';

/**
 * The poppy dialog window
 * 
 * A `Dialog` manages the popup window that hosts a poppy. It
 * opens the window (and creates the `<iframe>` sandbox), closes it automatically
 * when the page unloads, detects if the window is closed and does appropriate
 * cleanup, and makes sure only one dialog is open at a time.
 * 
 * It also triggers the Poppy I/O browser extension if that's available. In that
 * case the browser extension manages the popup window, but this class still
 * manages the proxy iframe and handles cleanup after the extension tells us the
 * window is closed.
 * 
 * Aside from that it has to be bound to a [[DialogOpener]] in order to do anything
 * useful.
 * 
 * You generally don't have to care about this class at all. But you might want
 * to make use of it if:
 * 
 *  1.  You want to be able to close the dialog before [[DialogOpener.match]]
 *      resolves.
 *  2.  You need to do something asynchronously between the time the user initiates
 *      opening the poppy and you know what to do with it. If you don't want
 *      your popup blocked you have to open it synchronously.
 *  3.  As a special case of (3), you want to defer loading code for as long as
 *      possible. This class is designed to be relatively minimal and everything
 *      else in `poppyio.js` can be loaded asynchronously after it.
 * 
 * For (1) and (2), the easiest thing to do is start with a `DialogOpener` and call the
 * open() method, and then use the `Dialog` you get back to establish a
 * connection rather than the `DialogOpener`. They're both [[Matcher]]s.
 * 
 * For (3), Create a new `Dialog`, call [[Dialog.open]] to open the window, and then
 * start loading the rest of the code. In order for a `Dialog` to do its
 * job as a `Matcher`, it must be bound to a `DialogOpener`. To do that,
 * grab a `DialogOpener`, and call [[DialogOpener.bind]] passing it the `PoppyDialog`. After 
 * that, you can use your `PoppyDialog` as a `Matcher` and establish
 * your connection.
 *
 * You can use the [[Dialog.popup]] property to access the popup window
 * and display some sort of loading message while you do your thing asychronously,
 * but if a browser extension is involved that won't be available. So check first.
 * 
 */
export class Dialog implements Matcher {

	/**
	 * The last opened `Dialog`, which may be currently open. After a `Dialog`
	 * is closed it's *not* cleared out from here, in case you might want to 
	 * investigate the object after the dialog is closed.
	 * 
	 * If for some reason you don't want your poppies to be modal, you
	 * can unset this before you open up the next poppy and it'll think it's
	 * the only game in town.
	 */
	static current?: Dialog;

	/**
	 * The current state of this dialog. The state moves in one direction down
	 * the line:
	 * 
	 * 1. `unopened`: The PoppyDialog "exists" as an object but not as an actual dialog.
	 * 2. `opened`: A popup dialog has been opened and now actually exists.
	 * 3. `matching`: A request has been made, but we haven't connected yet.
	 * 4. `connected`: A connection has been made and PoppySession established
	 * 5. `closed`: The popup is closed.
	 * 
	 * Note that we might skip over some steps and go straight to close, and an
	 * unopened dialog may stay unopened forever. :(
	 */
	state: 'unopened' | 'opened' | 'matching' | 'connected' | 'closed';

	/**
	 * The opener that this `Dialog` is bound to. In order for this `Dialog`
	 * to do anything other than open blank windows it needs one of these. If this
	 * dialog came from a [[DialogOpener]] (i.e. you didn't create it yourself), this
	 * is automatic. You can bind it after the fact by passing this `Dialog` through
	 * [[DialogOpener.bind]].
	 */
	opener?: DialogOpener;

	/**
	 * A list of origins that we're going to take messages from. If we get a
	 * message from an origin not in this list is ignored. You know, for "security".
	 */
	origins: string[];

	/**
	 * Once we establish a [[Session]] it gets put here. A `Dialog` can only
	 * ever create one `Session`.
	 */
	session?: Session;

	/**
	 * Close the popup window (and session). It's called cancel because you
	 * generally shouldn't call this unless something went wrong (in which case
	 * you really should call this). Under normal circumstances it's the poppy's
	 * job to decide when to close thr window since the poppy is what the user
	 * is interacting with.
	 * 
	 * (It's a function property and not a method on the class since we set it
	 * from inside the [[closed]] promise constructor).
	 */
	cancel: () => void;
	
	/**
	 * A promise that resolves after the dialog window is closed.
	 */
	closed: Promise<undefined>;

	/**
	 * This indicates that a Poppy I/O browser extension is present and has
	 * intercepted our request to open up a popup window and decided it's going
	 * to take take care of that, *thankyouverymuch*.
	 */
	intercepted: boolean;

	/**
	 * The proxy iframe that sits between the popup dialog and the client page.
	 * The main reason it exists is for the `<iframe>` element's sandboxing powers,
	 * in particular to block top-navigation. This stops the poppy from being
	 * sneaky and navigating us to another page while the user isn't paying
	 * attention.
	 * 
	 * Also, it kinda keeps the cross-document messages which are otherwise
	 * window-global in their own channel, since it's the iframe window they're
	 * being sent to, not our window. (Note that a non-well-behaved poppy might
	 * still send messages your way so this doesn't mean you can slack on validation.)
	 */
	proxy?: HTMLIFrameElement;

	/**
	 * The popup window we're taking care of. If we were intercepted by a browser
	 * extension then the popup is entirely out of our hands and this is set
	 * to nothing.
	 */
	popup?: Window|null;
	
	/**
	 * The `unload` listener to detect when the page is unloading and automatically
	 * close the popup because we are good and decent and clean up after ourselves.
	 * We save it here so that we can later remove it if the popup is closed
	 * *before* page unload and don't need it anymore, because we are good and
	 * decent and clean up after ourselves.
	 */
	private onUnload: ()=>void;

	/**
	 * The constructor.
	 * 
	 * Unless you have a specific reason to use this the easier way to get
	 * a `Dialog` is through [[Dialog.open]]. Granted it will already
	 * be open so maybe that's not what you want.
	 */
	constructor() {
		this.state = 'unopened';
		this.intercepted = false;
		// bind() doesn't just set this.opener = opener, it also blesses us with
		// whatever X interface the opener provides.
		this.closed = new Promise(resolve => {
			this.cancel = () => {
				resolve();
				if (this.state !== 'closed') {
					this.state = 'closed';
					removeEventListener('unload', this.onUnload);
					// Removing the iframe is what actually closes the popup
					this.proxy!.parentNode!.removeChild(this.proxy!);
				}
			}
		});
		this.onUnload = this.cancel.bind(this);
	}

	/**
	 * Open up a dialog window, but dont do anything with it yet.
	 * 
	 * This just sets everything up for [[request]]. The only reason you would need
	 * to call this is you need to do something asyncronously before you can
	 * call `request`, for example load some other modules, since opening a
	 * popup window has to triggered synchronously by a user action. Otherwise
	 * calling `request` will take care of opening the popup for you.
	 * 
	 * This will throw an exception if we weren't able to open up the popup
	 * window, like if the user has an overzealous popup blocker.
	 * 
	 * It's okay to call this method more than once before `request` is called
	 * and we move into the `matching` state. Not sure why you'd want to though.
	 * 
	 * @param options Options that would come from the [[DialogOpener]], but won't
	 *                because the `DialogOpener` doesn't exist yet. The only
	 *                property currently relevant is [[DialogOpenerProperties.iePrelude]].
	 */
	open(options?: DialogOpenerProperties): this {
		if (this.state === 'unopened') {
			options = options || {};
			if (Dialog.current) {
				Dialog.current.cancel();
			}
			Dialog.current = this;
	
			let popup: Window|undefined|null;
			let proxy = this.proxy = document.createElement('iframe');
			proxy.style.display = 'none';
			document.body.appendChild(proxy);
			const sandbox = 'allow-scripts allow-same-origin allow-forms allow-popups allow-pointer-lock';
			try {
				// TypeScript 2.8.2 DOM lib has the wrong type
				(<DOMSettableTokenList>proxy.sandbox).value = sandbox;
			} catch (e) {
				// Used to be a string and still is in UC Browser. 
				(<any>proxy.sandbox) = sandbox;
			}
			
			// Close the popup when the page is unloaded
			addEventListener('unload', this.onUnload);
			proxy.contentWindow!.addEventListener('unload', () => {
				// Since the popup's opener is actually the proxy iframe, the proxy
				// the proxy iframe has to be the one to close the popup.
				if (this.state === 'closed') {
					// But we don't close until the state of the dialog is "closed"
					// because on Firefox we get an unload event immediately when
					// the window is loaded. Weird. Fortunately on a page unload
					// the parent page gets it's unload event first, so we can set
					// the state to closed just in time.
					if (popup) popup.close();
				}
			});
	
			// Trigger the browser extension
			if (typeof CustomEvent === 'function') {
				this.intercepted = !proxy.dispatchEvent(new CustomEvent(
					'https://poppy.io/a/open',
					{ bubbles: true, cancelable: true }
				));
			}
	
			if (!this.intercepted) {
				// Actually open the popup window.
				let iePrelude = navigator.userAgent.match(/Trident/)
					&& options.iePrelude;
				popup = this.popup = proxy.contentWindow!.open(
					iePrelude || 'about:blank',
					undefined,
					`scrollbars=1,resizable=1,`
					+ `width=${window.outerWidth-100},`
					+ `height=${window.outerHeight-120},`
					+ `left=${window.screenX+40},`
					+ `top=${window.screenY+40}`
				);
				if (!popup) {
					throw new Error('Poppy.io: popup-blocked');
				}
				popup.location.replace('about:blank');
				// Detect if the popup is closed. I don't think there's an event
				// for us to listen for so we poll. :(
				let pollInterval = setInterval(() => {
					if (popup!.closed) {
						clearInterval(pollInterval);
						this.cancel();
					}
				}, 100);
			} else {
				// If our window open was intercepted by a browser extension they
				// are the ones to manage the popup. We get this event after it's
				// closed so we can clean up on our end.
				proxy.contentWindow!.addEventListener('https://poppy.io/a/close', () => this.cancel());
			}
			this.state = 'opened'; // I mean I should hope so.
		}
		return this;
	}

	/**
	 * Connect to a peer. Yay! See [[Matcher.match]] for how to
	 * use it. This will take care of opening the popup for you so you don't
	 * need to call [[open]] first.
	 * 
	 * In order for this to be useful this `Dialog` needs to be bound to a
	 * [[DialogOpener]]. See [[opener]] for how that happens. If it isn't it the
	 * promise will reject. It will also reject if we can't open a popup.
	 * 
	 * @param matchlist 
	 */
	match(matchlist: MatchOption|MatchOption[]): Promise<Session|undefined> {
		try {
			if (!this.opener) throw Error('Poppy.io: No Connector');
			return this.opener.match(matchlist, this);
		} catch (e) {
			console.log(e);
			this.cancel();
			return Promise.reject(e);
		}
	}

}

