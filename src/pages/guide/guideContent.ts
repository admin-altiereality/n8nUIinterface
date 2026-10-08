// The dashboard guide, from docs/manual/learnxr-dashboard-manual.html.
// {{img:name}} is replaced with the bundled screenshot src/assets/guide/name.jpg.
export const GUIDE_HTML = `
<div class="wrap">
  <nav class="toc" aria-label="Contents">
    <p>Contents</p>
    <ol>
      <li><a href="#start">Getting started</a></li>
      <li><a href="#routine">Your daily routine</a></li>
      <li class="group">Selling</li>
      <li><a href="#sales-home">Sales Home</a></li>
      <li><a href="#drawer">The lead drawer</a></li>
      <li><a href="#pipeline">Pipeline</a></li>
      <li><a href="#school">School page</a></li>
      <li><a href="#messaging">Messaging</a></li>
      <li><a href="#templates">WhatsApp templates</a></li>
      <li><a href="#campaigns">Campaigns</a></li>
      <li class="group">Managing</li>
      <li><a href="#team">Team</a></li>
      <li><a href="#customers">Customers</a></li>
      <li><a href="#social">Social Ads</a></li>
      <li><a href="#ops">Ops Dashboard</a></li>
      <li><a href="#admin">Admin</a></li>
      <li><a href="#builder">Builder</a></li>
      <li class="group">Reference</li>
      <li><a href="#automations">What runs by itself</a></li>
      <li><a href="#rules">Rules to know</a></li>
      <li><a href="#help">When something looks wrong</a></li>
    </ol>
  </nav>

  <main>
    <header class="top">
      <span class="eyebrow">LearnXR · Altie Reality</span>
      <h1>LearnXR Sales Dashboard Manual</h1>
      <p class="lede">How to find schools, work your leads, talk to them on WhatsApp, and keep an eye on the whole sales engine from one place.</p>
      <div class="meta"><span>Address <code>agents.altiereality.com</code></span><span>Updated 5 Oct 2026</span></div>
    </header>

    <section id="start">
      <h2>Getting started</h2>
      <p>Sign in with your work email at <strong>agents.altiereality.com</strong>. The left sidebar shows only the pages your role can use. If a page is missing, ask an admin to change your role; roles can't be changed from inside the dashboard. This guide is always one click away under <strong>Guide</strong> in the sidebar.</p>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Page</th><th>Superadmin</th><th>Associate</th><th>Salesperson</th><th>WhatsApp manager</th></tr></thead>
          <tbody>
            <tr><td>Sales Home, Pipeline, School, Campaigns, Team, Customers</td><td class="y">Yes</td><td class="y">Yes</td><td class="y">Yes</td><td class="n">No</td></tr>
            <tr><td>Messaging, Ops Dashboard</td><td class="y">Yes</td><td class="y">Yes</td><td class="y">Yes</td><td class="y">Yes</td></tr>
            <tr><td>Social Ads</td><td class="y">Yes</td><td class="y">View</td><td class="n">No</td><td class="n">No</td></tr>
            <tr><td>Admin (health and settings)</td><td class="y">Yes</td><td class="n">No</td><td class="n">No</td><td class="n">No</td></tr>
            <tr><td>Builder (VR lessons)</td><td class="y">Yes</td><td class="y">Yes</td><td class="n">No</td><td class="n">No</td></tr>
          </tbody>
        </table>
      </div>
      <p>Every lead moves through the same stages. A stage is set either by the system (an email sent, a reply, a booking) or by you in the lead drawer.</p>
      <div class="stages" aria-label="Lead stages">
        <span>New</span><i>→</i><span>Contacted</span><i>→</i><span>Engaged</span><i>→</i><span>Demo booked</span><i>→</i><span>Demo done</span><i>→</i><span>Proposal</span><i>→</i><span>Won / Lost</span>
      </div>
      <p><strong>New</strong> means found but not emailed yet. <strong>Contacted</strong> means the first email went out. <strong>Engaged</strong> means the school showed interest: a reply, a website or Instagram form, or a click on a demo or pricing link. From Engaged on, a person owns the deal.</p>
    </section>

    <section id="routine">
      <h2>Your daily routine</h2>
      <ol class="routine">
        <li><div><strong>Open Sales Home.</strong> Work the <span class="ui">Due now</span> list from the top. Overdue items are in red.</div></li>
        <li><div><strong>Claim what you'll work.</strong> Press <span class="ui">Claim</span> on a lead so nobody else calls the same school.</div></li>
        <li><div><strong>Call or WhatsApp.</strong> Use the buttons on the item. After a call, open the lead and press <span class="ui">Log call</span> with the outcome.</div></li>
        <li><div><strong>Set the next step.</strong> Every open deal needs a next step and a due date, or it falls into <span class="ui">No next step</span>.</div></li>
        <li><div><strong>Check Messaging</strong> for new school replies before you finish for the day.</div></li>
      </ol>
      <div class="note"><b class="lbl">Speed matters</b>A hot lead that hasn't heard from us within 1 business hour sends its owner an alert email; after 4 hours the manager is told. Business hours are Monday to Saturday, 10:00 to 19:00.</div>
    </section>

    <hr>

    <section id="sales-home">
      <h2>Sales Home <a class="path" href="/sales">/sales</a></h2>
      <p class="who">For everyone in sales. Your start page.</p>
      <figure>
        <img src="{{img:sales-home}}" width="1254" height="611" alt="Sales Home with source chips, five KPI tiles, the funnel line and the Channels table" loading="lazy">
        <figcaption>Top of Sales Home: source chips, this month's numbers, the funnel and the Channels table.</figcaption>
      </figure>
      <h3>What's on it</h3>
      <ul>
        <li><strong>Source chips</strong> (<span class="ui">All sources</span>, <span class="ui">Website</span>, <span class="ui">Cold email</span>…) narrow the whole page to leads from one source. The number on each chip is how many leads came from it.</li>
        <li><strong>Tiles:</strong> open pipeline value, won this month, demos booked this month, speed to lead (median time from a lead turning hot to the first call or message), and cost per demo.</li>
        <li><strong>Funnel line:</strong> how many leads ever reached each stage, with the conversion from the step before.</li>
        <li><strong>Channels:</strong> for each source, new leads, engaged, demos, won and ₹ won, for this month, last month or the last 90 days. Cost per lead, demo and deal appear once an admin enters monthly costs in Admin → Settings; Meta ad spend is added automatically.</li>
      </ul>
      <figure>
        <img src="{{img:sales-queue}}" width="1254" height="611" alt="The Due now and No next step lists with Claim, Call, WhatsApp, Done and Snooze buttons" loading="lazy">
        <figcaption>The work queue: <em>Due now</em> and <em>No next step</em>.</figcaption>
      </figure>
      <h3>Working the queue</h3>
      <ul>
        <li><span class="ui">Claim</span> makes you the owner. It fails if a colleague claimed the lead a moment before you.</li>
        <li><span class="ui">Call</span> opens your phone dialler and records a first touch. <span class="ui">WhatsApp</span> opens the chat in Messaging.</li>
        <li><span class="ui">Done</span> clears the next step. <span class="ui">Snooze</span> moves it to tomorrow morning.</li>
        <li><span class="ui">All</span> / <span class="ui">Mine</span> at the top switches between the team's queue and only your leads.</li>
        <li>Click a school's name to open its <a href="#drawer">lead drawer</a>.</li>
      </ul>
      <p>The page refreshes every minute.</p>
    </section>

    <section id="drawer">
      <h2>The lead drawer</h2>
      <p class="who">Opens from Sales Home, Pipeline, the School page and Team.</p>
      <figure>
        <img src="{{img:lead-drawer}}" width="1254" height="611" alt="Lead drawer showing owner, booking link, stage, deal value, next step, due date, note box, Log call and activity" loading="lazy">
        <figcaption>Everything you can change about one lead.</figcaption>
      </figure>
      <ul>
        <li><strong>Header:</strong> school, city, stage and source, plus a link to the <a href="#school">School page</a> with the full history.</li>
        <li><span class="ui">Claim</span> / <span class="ui">Unclaim</span>: take or release ownership.</li>
        <li><span class="ui">Booking link</span>: copies a demo booking link tied to this lead, so a booking is matched back to it.</li>
        <li><strong>Stage, deal value, students, package:</strong> change them and press <span class="ui">Save</span>. Choosing <em>Lost</em> asks for a reason.</li>
        <li><strong>Next step and due date:</strong> what happens next and when. This is what puts the lead on Sales Home at the right time.</li>
        <li><strong>Note:</strong> type what happened and press <span class="ui">Add note</span>.</li>
        <li><strong>Log call:</strong> pick the outcome (Interested, Call back later, Not interested, No answer, Wrong number) and press <span class="ui">Log call</span>. Anything typed in the note box is saved as the call's notes. Calls count on the <a href="#team">Team</a> leaderboard.</li>
        <li><strong>Copy a reply template:</strong> appears when admins have added templates. Copies the text with the contact's name and school filled in.</li>
        <li><strong>Activity:</strong> who changed what and when, newest first.</li>
      </ul>
    </section>

    <section id="pipeline">
      <h2>Pipeline <a class="path" href="/pipeline">/pipeline</a></h2>
      <p class="who">For everyone in sales.</p>
      <figure>
        <img src="{{img:pipeline}}" width="1254" height="611" alt="Pipeline board with columns New, Contacted, Engaged, Demo booked and Demo done" loading="lazy">
        <figcaption>Every school as a card, one column per stage.</figcaption>
      </figure>
      <ul>
        <li>Each column shows how many deals it holds and their total ₹ value.</li>
        <li>A flame marks a hot lead. A red date means the next step is overdue.</li>
        <li><strong>Channel partners</strong> (resellers) have violet cards with a <span class="ui">Channel partner</span> tag. Pick <span class="ui">Channel partners</span> in the source filter to see only them.</li>
        <li>Search by school, city or owner; filter by source; switch between <span class="ui">All</span> and <span class="ui">Mine</span>.</li>
        <li>Won and Lost are collapsed; press <span class="ui">Show</span> to expand them.</li>
        <li>Click a card to open its lead drawer and change its stage there.</li>
      </ul>
    </section>

    <section id="school">
      <h2>School page <span class="path">/schools/…</span></h2>
      <p class="who">Opened from the lead drawer link “School page and full timeline”.</p>
      <figure>
        <img src="{{img:school}}" width="1254" height="611" alt="School page with a contacts list on the left and a timeline with filter chips on the right" loading="lazy">
        <figcaption>All contacts at one school and every touch, on one timeline.</figcaption>
      </figure>
      <ul>
        <li><strong>Contacts:</strong> every person we have at this school (principal, coordinator…), grouped by email domain or phone number. Click one to open their drawer.</li>
        <li><strong>Timeline:</strong> how the lead arrived, emails sent, opened and clicked, replies, WhatsApp messages both ways, notes and calls, stage changes, demo, proposal, won or lost, and unsubscribes. Filter with <span class="ui">Email</span>, <span class="ui">WhatsApp</span>, <span class="ui">Forms</span>, <span class="ui">Deal</span> or <span class="ui">Notes &amp; calls</span>.</li>
        <li><strong>Customer health</strong> appears once the school is Won. See <a href="#customers">Customers</a>.</li>
      </ul>
      <p>Read the timeline before you call. It tells you what the school has already seen from us.</p>
    </section>

    <section id="messaging">
      <h2>Messaging <a class="path" href="/twilio-messaging">/twilio-messaging</a></h2>
      <p class="who">For sales and the WhatsApp manager. No screenshot here, because the page shows real conversations.</p>
      <ul>
        <li><strong>Chats</strong> on the left: every WhatsApp conversation, newest first. Filter with <span class="ui">Follow-up</span>, <span class="ui">Seen</span> or <span class="ui">Failed</span>, or search a name or number. <span class="ui">+</span> starts a new chat.</li>
        <li><strong>Conversation</strong> on the right, with the school's stage and owner, and <span class="ui">Claim</span>.</li>
        <li><strong>Quick replies</strong> above the text box: the booking link, “ask for a call time”, and any templates an admin added.</li>
      </ul>
      <div class="note warn"><b class="lbl">The 24-hour rule</b>WhatsApp lets you type freely only within <strong>24 hours of the school's last message</strong>. After that, the text box becomes <span class="ui">Choose a template…</span> and you can only send an approved template. Send the template first; once they reply, you can type freely again.</div>
      <p>Schools that reply STOP are blocked from further messages automatically.</p>
      <h3>Templates</h3>
      <p>Pick a template from <span class="ui">Choose a template…</span>. The list is grouped into <strong>Channel partner</strong>, <strong>School</strong> and <strong>Other</strong>, each in English and हिंदी. Which one to send when is in <a href="#templates">WhatsApp templates</a>.</p>
    </section>

    <section id="templates">
      <h2>WhatsApp templates</h2>
      <p class="who">For anyone who messages leads. Which template to send, when, and what to type.</p>
      <h3>How to send one</h3>
      <ol>
        <li>Open the lead and press <span class="ui">WhatsApp</span>, or open the chat in <a href="#messaging">Messaging</a>.</li>
        <li>Pick the template from <span class="ui">Choose a template…</span>, or press the green <span class="ui">Suggested next</span> button above it. Use the <strong>हिंदी</strong> version if the contact writes or speaks in Hindi, otherwise <strong>EN</strong>. Within 24 hours of their last message, press <span class="ui">Send a template</span> first.</li>
        <li>Check the boxes. <code>{{1}}</code> (their first name) and <code>{{2}}</code> (your first name) are filled for you. Type <code>{{3}}</code> yourself where the template needs it (see the tables).</li>
        <li>Read the preview, then send.</li>
      </ol>
      <p>The list only shows templates for this contact: a channel partner's chat shows partner templates, a school's chat shows school templates. <span class="ui">Suggested next</span> is the step after the last one they got (for a school after its demo, the next onboarding step; before that, the reply that fits what they said). Templates they already got sit at the bottom under <span class="ui">Already sent</span>.</p>
      <p>Every template has a <span class="ui">Call us</span> button that rings +91 86199 53434. Templates show in the list only after WhatsApp approves them, so a few onboarding steps may appear later.</p>

      <h3>Channel partners (resellers)</h3>
      <p>Partners are resellers, not school owners. Send one step at a time, and only after the previous step is done.</p>
      <div class="table-wrap">
        <table>
          <thead><tr><th>When</th><th>Template</th><th>Type in {{3}}</th><th>Button</th></tr></thead>
          <tbody>
            <tr><td>A reseller lead comes in from the ad or the website and you haven't spoken yet</td><td><em>partner form</em></td><td>Nothing</td><td>Fill partner form</td></tr>
            <tr><td>They want to talk first, or the form is already filled</td><td><em>partner book call</em></td><td>Nothing</td><td>Book a slot (Calendly)</td></tr>
            <tr><td>Right after your first call</td><td><em>step1 welcome</em>: the five steps ahead</td><td>Nothing</td><td>Call us</td></tr>
            <tr><td>They are ready to learn the product</td><td><em>step2 product kit</em></td><td>Link to the product and demo kit</td><td>Call us</td></tr>
            <tr><td>They have seen the product and asked about money</td><td><em>step3 commercials</em></td><td>Link to the price and margin sheet</td><td>Call us</td></tr>
            <tr><td>They agree to the terms</td><td><em>step4 agreement KYC</em>: asks for GST, PAN, address proof and bank details</td><td>Link to the partner agreement</td><td>Call us</td></tr>
            <tr><td>Documents are verified</td><td><em>step5 pitch kit</em></td><td>Link to the brochure, deck and FAQs</td><td>Book a joint demo</td></tr>
            <tr><td>Agreement signed, partner set up</td><td><em>step6 live</em></td><td>Their partner ID</td><td>Call us</td></tr>
          </tbody>
        </table>
      </div>

      <h3>Schools after a demo</h3>
      <div class="table-wrap">
        <table>
          <thead><tr><th>When</th><th>Template</th><th>Type in {{3}}</th></tr></thead>
          <tbody>
            <tr><td>Same day as the demo</td><td><em>step1 demo recap</em></td><td>Nothing</td></tr>
            <tr><td>The proposal is ready</td><td><em>step2 proposal</em></td><td>Link to the proposal</td></tr>
            <tr><td>The school confirms the order</td><td><em>step3 setup checklist</em>: room, power, Wi-Fi, coordinator</td><td>Nothing</td></tr>
            <tr><td>Training date fixed</td><td><em>step4 teacher training</em></td><td>The date and time, e.g. 15 Oct, 11 am</td></tr>
            <tr><td>Headsets installed and teachers trained</td><td><em>step5 go live</em></td><td>Nothing</td></tr>
          </tbody>
        </table>
      </div>

      <h3>Answering a school that wrote back</h3>
      <p>Use these when a school replied but it has been more than 24 hours, so you can't type freely. Each one says someone from our team will call them, so call them soon after.</p>
      <div class="table-wrap">
        <table>
          <thead><tr><th>They said</th><th>Template</th><th>Button</th></tr></thead>
          <tbody>
            <tr><td>Sounds interesting, tell me more</td><td><em>reply positive</em></td><td>Book now</td></tr>
            <tr><td>Can we see a demo?</td><td><em>reply demo</em></td><td>Book now</td></tr>
            <tr><td>What does it cost?</td><td><em>reply pricing</em></td><td>Book now</td></tr>
            <tr><td>Maybe later, or no clear answer</td><td><em>reply neutral</em></td><td>Try the free app</td></tr>
            <tr><td>Not interested</td><td><em>reply negative</em></td><td>Explore the app</td></tr>
          </tbody>
        </table>
      </div>
      <p>Templates under <strong>Other</strong> are older ones. Prefer the ones above, which include the call line and button.</p>
    </section>

    <section id="campaigns">
      <h2>Campaigns <a class="path" href="/sales-funnel">/sales-funnel</a></h2>
      <p class="who">For everyone in sales. This is where new schools come from.</p>
      <figure>
        <img src="{{img:campaigns}}" width="1254" height="611" alt="Campaigns page with Launch Campaign form, Last run summary, Hot Schools, Email Template Leaderboard and City Funnel" loading="lazy">
        <figcaption>Run a city, then watch what came back.</figcaption>
      </figure>
      <h3>Running a city</h3>
      <ol>
        <li>Type a <strong>City</strong> and pick <strong>Schools to find</strong> (CBSE, ICSE, IB, international or all).</li>
        <li>Press <span class="ui">Run Pipeline</span>. A run takes about 8 minutes.</li>
        <li>Behind the scenes, the run finds schools on Google Maps and drops junk and schools we already have. It then reads each school's website for a verified principal, email and an opening line, scores the fit, and adds the good ones to the sheet as New.</li>
        <li>The best fits get their first email right away, within the daily cap. <span class="ui">Last run</span> shows schools found, new in the sheet and first emails sent.</li>
      </ol>
      <h3>Reading the results</h3>
      <ul>
        <li><strong>Hot Schools:</strong> the schools clicking and replying most, scored by intent (demo and pricing clicks count most).</li>
        <li><strong>Email Template Leaderboard:</strong> how each first-email version performs.</li>
        <li><strong>City Funnel:</strong> leads, contacted, replied, demos and won per city.</li>
      </ul>
      <p>Follow-up emails go out by themselves at 10:30 on Monday to Saturday. They are not listed under runs; their last run is shown as one line on this page.</p>
    </section>

    <hr>

    <section id="team">
      <h2>Team <a class="path" href="/team">/team</a></h2>
      <p class="who">For everyone in sales.</p>
      <figure>
        <img src="{{img:team}}" width="1254" height="611" alt="Team page with a leaderboard table and a list of hot leads waiting for a first call" loading="lazy">
        <figcaption>The leaderboard and the hot leads still waiting.</figcaption>
      </figure>
      <ul>
        <li><strong>Leaderboard</strong> for the last 7, 30 or 90 days: deals won and ₹, demos booked, calls, all touches (notes, calls, updates), open deals, and speed to lead.</li>
        <li><strong>Hot leads waiting for a first call:</strong> how long each has waited in business time and who owns it. Calling or messaging from the drawer clears it.</li>
      </ul>
      <p>Log every call with <span class="ui">Log call</span>; unlogged calls don't count.</p>
    </section>

    <section id="customers">
      <h2>Customers <a class="path" href="/customers">/customers</a></h2>
      <p class="who">For everyone in sales. Empty until the first deal is marked Won.</p>
      <figure>
        <img src="{{img:customers}}" width="1254" height="611" alt="Customers page with columns School, Won, Value, Owner, Health, Active teachers, Active students and Renews" loading="lazy">
        <figcaption>Schools that bought LearnXR.</figcaption>
      </figure>
      <ul>
        <li>Each won school is listed with its deal value and owner, its <strong>health</strong> (healthy, watch, at risk or not started), active teachers and students in the last 30 days, and its renewal date.</li>
        <li>The riskiest schools are listed first.</li>
        <li><strong>Linking:</strong> on the school's page, the Customer health panel suggests the matching school in the LearnXR app. Press <span class="ui">Link</span> once to connect them.</li>
        <li><strong>Renewal date</strong> defaults to a year after the deal was won; change it on the school page. Reminder emails go out 60, 30 and 7 days before.</li>
      </ul>
    </section>

    <section id="social">
      <h2>Social Ads <a class="path" href="/social">/social</a></h2>
      <p class="who">For superadmins and associates.</p>
      <figure>
        <img src="{{img:social}}" width="1254" height="611" alt="Social Ads page with a snapshot banner, six KPI tiles, a campaigns table and an Instagram posts section" loading="lazy">
        <figcaption>Instagram and Facebook ads for the Altie Reality Page.</figcaption>
      </figure>
      <ul>
        <li>Spend, reach, clicks, leads, cost per lead and Meta leads in the sheet, for the chosen date range.</li>
        <li>Campaigns and ad sets with their status and budget. <span class="ui">Ads Manager</span> opens Meta's own tool.</li>
        <li>A blue banner means you're looking at a <strong>read-only snapshot</strong>, refreshed every morning. Pausing, budgets and boosting Instagram posts switch on once the live Meta connection is set up.</li>
        <li>Leads from Instagram or Facebook lead forms are copied into the lead sheet every 5 minutes with their source, campaign and form, so they appear on Sales Home and in Pipeline like any other lead. Their thank-you screen asks them to message us on WhatsApp.</li>
      </ul>
    </section>

    <section id="ops">
      <h2>Ops Dashboard <a class="path" href="/dashboard">/dashboard</a></h2>
      <p class="who">For sales and the WhatsApp manager.</p>
      <figure>
        <img src="{{img:ops}}" width="1254" height="465" alt="Ops Dashboard with tiles for active runs, delivered and read today, total leads and failed WhatsApp, plus leads by status and campaign analytics by city" loading="lazy">
        <figcaption>Delivery and follow-up health at a glance.</figcaption>
      </figure>
      <ul>
        <li>Active runs, WhatsApp delivered and read today, total leads, failed WhatsApp sends.</li>
        <li>Leads by status, and per city: scraped, emailed, WhatsApp sent, delivered, read, replied, failed.</li>
        <li>Further down: overdue follow-ups, failed WhatsApp sends (with an <span class="ui">Open chat</span> link) and the audit log.</li>
        <li><span class="ui">CSV</span> downloads the lead list.</li>
      </ul>
    </section>

    <section id="admin">
      <h2>Admin <a class="path" href="/admin">/admin</a></h2>
      <p class="who">For superadmins only.</p>
      <figure>
        <img src="{{img:admin}}" width="1254" height="611" alt="Admin page with health tiles, a product-data notice, four workflow health cards and the settings form" loading="lazy">
        <figcaption>System health on top, settings below.</figcaption>
      </figure>
      <h3>Health</h3>
      <ul>
        <li>Cold emails sent today against the daily cap, WhatsApp failures in the last 24 hours, approved WhatsApp templates, and the Meta connection.</li>
        <li>One card per automation: <strong>Outbound</strong> (city runs, first emails, follow-ups), <strong>Inbound</strong> (replies, website and Meta leads, email events), <strong>Leads</strong> (reads and writes the lead sheet) and <strong>Alerts</strong>. A red card shows how many errors happened in the last day, with <span class="ui">Open last error</span>.</li>
      </ul>
      <h3>Settings</h3>
      <ul>
        <li><strong>Monthly revenue target</strong> and <strong>monthly cost per channel</strong>: these feed Sales Home and the Channels table.</li>
        <li><strong>Cold emails per day</strong> and <strong>how many may be follow-ups</strong>. Keep this low while the sending domain is new.</li>
        <li><strong>Automatic WhatsApp replies</strong> and <strong>WhatsApp welcome</strong>: <em>Test</em> sends only to internal numbers; <em>Live</em> sends to schools. Switching to Live asks you to confirm.</li>
        <li><strong>Meta daily budget ceiling</strong>, <strong>alert recipients</strong> and <strong>reply templates</strong> (use <code>{{name}}</code> and <code>{{school}}</code>).</li>
      </ul>
      <p>Press <span class="ui">Save settings</span>. Changes reach the automations within a minute and are recorded in the audit log.</p>
    </section>

    <section id="builder">
      <h2>Builder <span class="path">/</span></h2>
      <p class="who">For superadmins, associates and builders.</p>
      <figure>
        <img src="{{img:builder}}" width="1254" height="611" alt="Lesson Builder with a PDF upload area, AI context box, lesson metadata and the automation pipeline steps" loading="lazy">
        <figcaption>Turn a textbook chapter into a VR lesson.</figcaption>
      </figure>
      <ol>
        <li>Drop a PDF chapter (up to 50 MB) into <span class="ui">Content Source</span>.</li>
        <li>Optionally add instructions in <span class="ui">AI Context</span>.</li>
        <li>Choose language, curriculum, grade and subject.</li>
        <li>Press <span class="ui">Generate VR Lesson</span> and follow the steps in <span class="ui">Automation Pipeline</span> and <span class="ui">Live Execution</span>.</li>
      </ol>
      <p>A sample lesson built for a prospect is a strong way to move a deal from Demo done to Proposal.</p>
    </section>

    <hr>

    <section id="automations">
      <h2>What runs by itself</h2>
      <div class="table-wrap">
        <table>
          <thead><tr><th>When</th><th>What happens</th><th>What you see</th></tr></thead>
          <tbody>
            <tr><td>When you run a city</td><td>Schools found and checked, first emails sent within the cap</td><td>New and Contacted leads; Campaigns updates</td></tr>
            <tr><td>Mon–Sat 10:30</td><td>Follow-up emails 1–3 to schools that haven't replied</td><td>Follow-up counts on leads</td></tr>
            <tr><td>As it happens</td><td>WhatsApp replies are read and classified; website form leads are added or matched to a school we already have</td><td>Lead becomes Engaged and hot; alert email</td></tr>
            <tr><td>Every 5 minutes</td><td>New Instagram/Facebook lead-form leads are copied from Meta and added or matched to a school we already have</td><td>Facebook/Instagram ad lead on Sales Home; alert email</td></tr>
            <tr><td>Every 15 minutes</td><td>Website contact-form messages and report downloads are checked for spam and added as leads</td><td>New website leads</td></tr>
            <tr><td>Every 30 minutes, business hours</td><td>Hot leads with no call or message yet</td><td>Alert to the owner after 1 hour, the manager after 4</td></tr>
            <tr><td>Daily 9:30</td><td>Customer renewals coming up</td><td>Reminder at 60, 30 and 7 days</td></tr>
            <tr><td>Monday 9:00</td><td>Weekly digest</td><td>Email: leads by source, overdue deals, waiting hot leads, team activity</td></tr>
            <tr><td>When anything fails</td><td>Error report</td><td>Alert email with the failed step</td></tr>
          </tbody>
        </table>
      </div>
    </section>

    <section id="rules">
      <h2>Rules to know</h2>
      <ul>
        <li><strong>Do not contact</strong> is permanent. A school that unsubscribes from email or replies STOP on WhatsApp is never messaged again, and you can't override it.</li>
        <li><strong>One school, one row.</strong> If a school fills a form after we already emailed them, their existing lead is updated rather than duplicated. Check the School page for every contact.</li>
        <li><strong>Milestones keep their first date.</strong> Hot, first touch, demo booked, demo done, proposal sent and won keep the date they first happened, so reports stay honest.</li>
        <li><strong>Test rows:</strong> schools named “ZZ Test …” are for testing and are hidden from the dashboard.</li>
        <li><strong>WhatsApp after 24 hours</strong> needs an approved template.</li>
      </ul>
    </section>

    <section id="help">
      <h2>When something looks wrong</h2>
      <h3>A page shows an error or stays empty</h3>
      <p>Press <span class="ui">Refresh</span> on the page. If it persists, an admin should check Admin → Health. A service-unavailable error across every page usually means a problem with the Google Cloud account, such as billing.</p>
      <h3>“Someone else has already claimed this lead”</h3>
      <p>A colleague claimed it first. Talk to them, or ask a superadmin to reassign it.</p>
      <h3>I can't type a WhatsApp message</h3>
      <p>The school's last message is older than 24 hours. Pick an approved template instead.</p>
      <h3>A school I emailed isn't on Sales Home</h3>
      <p>Sales Home only lists work that is due. Find any school in Pipeline by searching its name.</p>
      <h3>Numbers look off</h3>
      <p>Pages refresh every minute; the lead list itself is cached for up to a minute. Cost figures need monthly costs in Admin → Settings.</p>
    </section>

    <footer>LearnXR Sales Dashboard · agents.altiereality.com · Screenshots taken 4 Oct 2026; lead details are blurred.</footer>
  </main>
</div>
`;
