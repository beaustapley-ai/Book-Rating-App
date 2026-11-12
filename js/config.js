/* =====================================================================
   Book List — settings for this copy of the site
   ---------------------------------------------------------------------
   Both values are safe to publish in a public repo: the API checks every
   request against a signed-in session, and a Google Client ID is public by
   design (it only works from the origins you list in Google Cloud).
   ===================================================================== */
var CONFIG = {
  // Apps Script → Deploy → Manage deployments → Web app URL (ends in /exec)
  API_URL: 'https://script.google.com/macros/s/AKfycbxO1Q6B92Iq_eVdPrjOFA48eDZbFrNd_UlLYiZmJwdkIYIPfQ91jgDiuToNQmi0KEJ8cA/exec',

  // Google Cloud → APIs & Services → Credentials → OAuth client ID (Web).
  // Leave '' to hide the Google button and use email/phone + password only.
  GOOGLE_CLIENT_ID: '249149311702-slfvkd2pehnkv51nsugchrh8u6i2kieq.apps.googleusercontent.com',

  // Prefix for anything saved in the browser. Every GitHub Pages site under
  // your username shares one origin, so this keeps the book app's sign-in
  // separate from your other apps.
  STORAGE_PREFIX: 'booklist_'
};
