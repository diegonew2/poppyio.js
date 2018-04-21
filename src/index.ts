// Export core
export { Matcher, MatchOption, Session, validateMatchlist } from './core/common';
export { Dialog } from './core/dialog';
export { DialogOpener, DialogOpenerProperties } from './core/dialog-opener';
export { ServiceRequest } from './core/service-request';

// Export SOAP
export { acceptObject, beginAcceptObject, AcceptObjectArgs, AcceptedObject, BeginAcceptObjectArgs } from './soap/accept';
export { offerObject, beginOfferObject, OfferObjectArgs, BeginOfferObjectArgs, ObjectOffer, AcceptedObjectOffer } from './soap/offer';

// Export user-friendly opener
export { Opener, Opener as default } from "./opener";

/**
 * Version of poppyio.js
 */
export const version: string = '$Version$';
