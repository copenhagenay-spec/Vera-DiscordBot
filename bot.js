require('dotenv').config();

const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
  ChannelType,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
} = require('discord.js');
const express = require('express');
const multer  = require('multer');
const fs      = require('fs');
const path    = require('path');

const TOKEN                    = process.env.DISCORD_TOKEN;
const GUILD_ID                 = process.env.GUILD_ID;
const BUG_REPORT_CHANNEL_ID    = process.env.BUG_REPORT_CHANNEL_ID;
const TICKET_CHANNEL_ID        = process.env.TICKET_CHANNEL_ID;
const CONFIRMED_BUGS_CHANNEL_ID = process.env.CONFIRMED_BUGS_CHANNEL_ID;
const STAFF_ROLE_ID            = process.env.STAFF_ROLE_ID;
const USER_ROLE_ID             = process.env.USER_ROLE_ID;
const VERA_SECRET              = process.env.VERA_SECRET;
const HTTP_PORT                = process.env.HTTP_PORT || 8080;

const TICKETS_FILE = path.join(__dirname, 'tickets.json');

function loadTickets() {
  if (!fs.existsSync(TICKETS_FILE)) return { next_id: 1, tickets: {} };
  return JSON.parse(fs.readFileSync(TICKETS_FILE, 'utf8'));
}

function saveTickets(data) {
  fs.writeFileSync(TICKETS_FILE, JSON.stringify(data, null, 2));
}

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });

async function addStaffToThread(thread, guild) {
  if (!STAFF_ROLE_ID) return;
  try {
    const staffRole = await guild.roles.fetch(STAFF_ROLE_ID);
    if (staffRole) {
      for (const [, member] of staffRole.members) {
        await thread.members.add(member.id);
      }
    }
  } catch (err) {
    console.error('Failed to add staff to thread:', err);
  }
}

function buildThreadName(ticketId, version, discord_username) {
  const user = discord_username ? `${discord_username}'s` : 'Bug';
  return `${user} Ticket #${ticketId} — v${version}`;
}

const TICKET_CATEGORIES = {
  support:     { label: 'Support Ticket',        emoji: '🔧', description: 'Having an issue? Get help here.' },
  prepurchase: { label: 'Pre-Purchase Question', emoji: '❓', description: 'Questions before buying? Ask here.' },
  business:    { label: 'Business Inquiry',      emoji: '🤝', description: 'Partnerships, business requests, etc.' },
};

// ── Express + multer ──────────────────────────────────────────────────────────

const app    = express();
const upload = multer({ storage: multer.memoryStorage() });

function verifyToken(req, res, next) {
  const token = req.headers['x-vera-token'];
  if (!token || token !== VERA_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

app.post('/report', verifyToken, upload.single('log_zip'), async (req, res) => {
  const { version, description, discord_username } = req.body;

  if (!version || !description) {
    return res.status(400).json({ error: 'version and description are required' });
  }

  try {
    const guild   = await client.guilds.fetch(GUILD_ID);
    const channel = await guild.channels.fetch(BUG_REPORT_CHANNEL_ID);

    if (!channel || channel.type !== ChannelType.GuildText) {
      return res.status(500).json({ error: 'BUG_REPORT_CHANNEL_ID is not a text channel' });
    }

    const ticketsData = loadTickets();
    const ticketId    = ticketsData.next_id;

    const embed = new EmbedBuilder()
      .setTitle(`Bug Report #${ticketId}`)
      .setColor(0xff4444)
      .setTimestamp()
      .addFields(
        { name: 'Ticket #',         value: String(ticketId),                   inline: true },
        { name: 'VERA Version',     value: version,                            inline: true },
        { name: 'Discord Username', value: discord_username || 'not provided', inline: true },
        { name: 'Description',      value: description },
      );

    const thread = await channel.threads.create({
      name: buildThreadName(ticketId, version, discord_username),
      type: ChannelType.PrivateThread,
    });

    const messagePayload = { embeds: [embed] };
    if (req.file) {
      messagePayload.files = [{
        attachment: req.file.buffer,
        name: req.file.originalname || `bug_report_${ticketId}.zip`,
      }];
    }

    await thread.send(messagePayload);
    await addStaffToThread(thread, guild);
    if (STAFF_ROLE_ID) await thread.send(`<@&${STAFF_ROLE_ID}> new bug report.`);

    ticketsData.tickets[String(ticketId)] = { threadId: thread.id, status: 'open', type: 'bug' };
    ticketsData.next_id = ticketId + 1;
    saveTickets(ticketsData);

    const threadUrl = `https://discord.com/channels/${GUILD_ID}/${thread.id}`;
    return res.json({ ticket_id: ticketId, thread_url: threadUrl });

  } catch (err) {
    console.error('Error creating ticket:', err);
    return res.status(500).json({ error: err.message });
  }
});

// ── Slash commands ────────────────────────────────────────────────────────────

const commands = [
  new SlashCommandBuilder()
    .setName('close')
    .setDescription('Mark this ticket as resolved')
    .addStringOption(opt =>
      opt.setName('reason').setDescription('Reason for closing').setRequired(false)
    ),
  new SlashCommandBuilder()
    .setName('note')
    .setDescription('Post a staff note in this ticket thread')
    .addStringOption(opt =>
      opt.setName('text').setDescription('Note content').setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName('confirm')
    .setDescription('Confirm a bug and post it to the confirmed-bugs channel')
    .addStringOption(opt =>
      opt.setName('title').setDescription('Short bug title').setRequired(true)
    )
    .addStringOption(opt =>
      opt.setName('description').setDescription('What the bug does').setRequired(true)
    )
    .addStringOption(opt =>
      opt.setName('affected_version').setDescription('Version(s) affected (e.g. 0.97.8)').setRequired(false)
    ),
  new SlashCommandBuilder()
    .setName('fixed')
    .setDescription('Mark the confirmed bug linked to this thread as fixed')
    .addStringOption(opt =>
      opt.setName('version').setDescription('Version the fix ships in (e.g. 0.97.8.1)').setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName('setup-tickets')
    .setDescription('Post the ticket panel in this channel'),
  new SlashCommandBuilder()
    .setName('setup-rules')
    .setDescription('Post the rules and accept button in this channel'),
];

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  try {
    await rest.put(
      Routes.applicationGuildCommands(client.user.id, GUILD_ID),
      { body: commands.map(c => c.toJSON()) }
    );
    console.log('Slash commands registered');
  } catch (err) {
    console.error('Failed to register slash commands:', err);
  }
  app.listen(HTTP_PORT, () => console.log(`HTTP server listening on port ${HTTP_PORT}`));
});

client.on('interactionCreate', async (interaction) => {

  // ── /setup-rules ──────────────────────────────────────────────────────────
  if (interaction.isChatInputCommand() && interaction.commandName === 'setup-rules') {
    const rulesEmbed = new EmbedBuilder()
      .setTitle('Welcome to the V.E.R.A. Support Discord!')
      .setDescription('Before you get access, please read and accept the rules below.')
      .setColor(0x5865f2)
      .addFields(
        { name: '📌 Rule 1 — Be Respectful',           value: 'Treat everyone with respect. No harassment, hate speech, discrimination, or personal attacks. Disagreements are fine — being a jerk is not.' },
        { name: '📌 Rule 2 — Keep It On Topic',        value: 'Each channel has a purpose. Keep conversations relevant to the channel you\'re in. General chat goes in #general, support questions go in #support or via a ticket.' },
        { name: '📌 Rule 3 — No Spam',                 value: 'No spam, excessive tagging, repeated messages, or flooding the chat. Don\'t ping staff for non-urgent issues — open a ticket instead.' },
        { name: '📌 Rule 4 — No Piracy or Cracking',  value: 'Do not share, request, or discuss cracked, pirated, or stolen software of any kind. This includes VERA itself. Violations result in an immediate ban.' },
        { name: '📌 Rule 5 — No Self Promotion',       value: 'Do not advertise other Discord servers, products, or services without staff approval. This includes DM advertising.' },
        { name: '📌 Rule 6 — English Only',            value: 'Please keep all messages in English so staff can moderate effectively.' },
        { name: '📌 Rule 7 — Use The Right Channels',  value: '• Bug reports → use the Bug Report button in VERA\n• Setup help → open a Support ticket\n• Questions before buying → open a Pre-Purchase ticket\n• General chat → #general' },
        { name: '📌 Rule 8 — No Personal Information', value: 'Do not share your own or anyone else\'s personal information in this server.' },
        { name: '📌 Rule 9 — Follow Discord\'s ToS',   value: 'You must be 13 or older to use Discord. Follow Discord\'s ToS and Community Guidelines at all times.' },
        { name: '📌 Rule 10 — Staff Decisions Are Final', value: 'If a staff member asks you to stop doing something, stop. Appeals can be made via ticket.' },
      )
      .setFooter({ text: 'By clicking Accept below you confirm you have read and agree to these rules.' });

    const button = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('accept_rules')
        .setLabel('Accept Rules')
        .setStyle(ButtonStyle.Success)
        .setEmoji('✅')
    );

    await interaction.reply({ embeds: [rulesEmbed], components: [button] });
    return;
  }

  // ── Button: accept rules ──────────────────────────────────────────────────
  if (interaction.isButton() && interaction.customId === 'accept_rules') {
    try {
      const guild  = await client.guilds.fetch(GUILD_ID);
      const member = await guild.members.fetch(interaction.user.id);
      await member.roles.add(USER_ROLE_ID);
      await interaction.reply({ content: 'You\'re all set! Welcome to the server.', ephemeral: true });
    } catch (err) {
      console.error('Failed to assign role:', err);
      await interaction.reply({ content: 'Something went wrong assigning your role. Please contact a staff member.', ephemeral: true });
    }
    return;
  }

  // ── /setup-tickets ────────────────────────────────────────────────────────
  if (interaction.isChatInputCommand() && interaction.commandName === 'setup-tickets') {
    const panelEmbed = new EmbedBuilder()
      .setTitle('Please Select Your Ticket')
      .setDescription('Need help or want to reach out? Pick the option that fits your request best and we will point you in the right direction.')
      .setColor(0x5865f2)
      .addFields(
        { name: 'How it works', value: '1. Click **Create Ticket** and choose a category\n2. Fill out the info needed\n3. We\'ll respond as quickly as possible' },
        { name: 'Ticket Options', value:
          '🔧 **Support Ticket:** Having an issue with VERA? Get help here.\n' +
          '❓ **Pre-Purchase Question:** Questions before buying? Ask here.\n' +
          '🤝 **Business Inquiry:** Partnerships, business requests, etc.'
        },
      );

    const button = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('open_ticket_menu')
        .setLabel('Create Ticket')
        .setStyle(ButtonStyle.Primary)
        .setEmoji('🎫')
    );

    await interaction.reply({ embeds: [panelEmbed], components: [button] });
    return;
  }

  // ── Button: open category select ──────────────────────────────────────────
  if (interaction.isButton() && interaction.customId === 'open_ticket_menu') {
    const select = new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('ticket_category')
        .setPlaceholder('Choose a category...')
        .addOptions(
          Object.entries(TICKET_CATEGORIES).map(([value, { label, emoji, description }]) =>
            new StringSelectMenuOptionBuilder()
              .setLabel(label)
              .setDescription(description)
              .setValue(value)
              .setEmoji(emoji)
          )
        )
    );

    await interaction.reply({ content: 'What do you need help with?', components: [select], ephemeral: true });
    return;
  }

  // ── Select menu: create ticket thread ─────────────────────────────────────
  if (interaction.isStringSelectMenu() && interaction.customId === 'ticket_category') {
    const category = interaction.values[0];
    const catInfo  = TICKET_CATEGORIES[category];
    const username = interaction.user.username;

    try {
      const guild         = await client.guilds.fetch(GUILD_ID);
      const ticketChannel = await guild.channels.fetch(TICKET_CHANNEL_ID);

      if (!ticketChannel || ticketChannel.type !== ChannelType.GuildText) {
        return interaction.reply({ content: 'Ticket channel not configured correctly.', ephemeral: true });
      }

      const ticketsData = loadTickets();
      const ticketId    = ticketsData.next_id;

      const thread = await ticketChannel.threads.create({
        name: `${catInfo.emoji} ${username}'s ${catInfo.label} #${ticketId}`,
        type: ChannelType.PrivateThread,
      });

      const openEmbed = new EmbedBuilder()
        .setTitle(`${catInfo.emoji} ${catInfo.label}`)
        .setColor(0x5865f2)
        .setTimestamp()
        .addFields(
          { name: 'Opened by', value: `<@${interaction.user.id}>`, inline: true },
          { name: 'Category',  value: catInfo.label,               inline: true },
        )
        .setDescription('Please describe your issue or question and a staff member will be with you shortly.');

      await thread.send({ embeds: [openEmbed] });
      await thread.members.add(interaction.user.id);
      await addStaffToThread(thread, guild);
      if (STAFF_ROLE_ID) await thread.send(`<@&${STAFF_ROLE_ID}> new ${catInfo.label.toLowerCase()}.`);

      ticketsData.tickets[String(ticketId)] = { threadId: thread.id, status: 'open', type: category };
      ticketsData.next_id = ticketId + 1;
      saveTickets(ticketsData);

      await interaction.reply({
        content: `Your ticket has been created! Head over here: <#${thread.id}>`,
        ephemeral: true,
      });

    } catch (err) {
      console.error('Error creating ticket thread:', err);
      await interaction.reply({ content: `Failed to create ticket: ${err.message}`, ephemeral: true });
    }
    return;
  }

  // ── Slash command interactions ─────────────────────────────────────────────
  if (!interaction.isChatInputCommand()) return;

  const { commandName, channel } = interaction;

  if (!channel.isThread()) {
    return interaction.reply({ content: 'This command can only be used inside a ticket thread.', ephemeral: true });
  }

  const ticketsData = loadTickets();
  const ticketEntry = Object.entries(ticketsData.tickets).find(([, t]) => t.threadId === channel.id);

  if (!ticketEntry) {
    return interaction.reply({ content: 'This thread is not a tracked ticket.', ephemeral: true });
  }

  const [ticketId, ticket] = ticketEntry;

  if (commandName === 'confirm') {
    if (!CONFIRMED_BUGS_CHANNEL_ID) {
      return interaction.reply({ content: 'CONFIRMED_BUGS_CHANNEL_ID is not set in environment.', ephemeral: true });
    }

    const title           = interaction.options.getString('title');
    const description     = interaction.options.getString('description');
    const affectedVersion = interaction.options.getString('affected_version') || 'unknown';

    try {
      const guild       = await client.guilds.fetch(GUILD_ID);
      const forumChannel = await guild.channels.fetch(CONFIRMED_BUGS_CHANNEL_ID);

      if (!forumChannel || forumChannel.type !== ChannelType.GuildForum) {
        return interaction.reply({ content: 'CONFIRMED_BUGS_CHANNEL_ID must be a Forum channel.', ephemeral: true });
      }

      const forumPost = await forumChannel.threads.create({
        name: `${title} | Status: 🔴 Open`,
        message: {
          content: `**Version affected:** ${affectedVersion}\n\n${description}\n\n**Status:** 🔴 Open`,
        },
      });

      // Store the confirmed post ID against this dev thread
      ticketsData.tickets[ticketId].confirmedPostId   = forumPost.id;
      ticketsData.tickets[ticketId].confirmedPostName = title;
      saveTickets(ticketsData);

      await interaction.reply({
        content: `Bug confirmed and posted: <#${forumPost.id}>`,
        ephemeral: true,
      });
    } catch (err) {
      console.error('Error creating confirmed bug post:', err);
      return interaction.reply({ content: `Failed to create confirmed bug post: ${err.message}`, ephemeral: true });
    }
    return;
  }

  if (commandName === 'fixed') {
    const version = interaction.options.getString('version');

    if (!ticket.confirmedPostId) {
      return interaction.reply({ content: 'No confirmed bug post is linked to this thread. Run /confirm first.', ephemeral: true });
    }

    try {
      const guild    = await client.guilds.fetch(GUILD_ID);
      const forumPost = await guild.channels.fetch(ticket.confirmedPostId);

      if (!forumPost) {
        return interaction.reply({ content: 'Could not find the linked confirmed bug post.', ephemeral: true });
      }

      const cleanTitle = ticket.confirmedPostName || forumPost.name.replace(/\s*\|.*$/, '').trim();
      await forumPost.setName(`${cleanTitle} | Status: ✅ Fixed`);
      await forumPost.send(`**Fixed in:** v${version}`);

      ticketsData.tickets[ticketId].status = 'fixed';
      saveTickets(ticketsData);

      await interaction.reply({ content: `Marked as fixed in v${version}.`, ephemeral: true });
    } catch (err) {
      console.error('Error updating confirmed bug post:', err);
      return interaction.reply({ content: `Failed to update confirmed bug post: ${err.message}`, ephemeral: true });
    }
    return;
  }

  if (commandName === 'close') {
    if (ticket.status === 'closed') {
      return interaction.reply({ content: 'This ticket is already closed.', ephemeral: true });
    }
    const reason = interaction.options.getString('reason') || 'No reason provided';
    try {
      await channel.setName(`[CLOSED] ${channel.name}`);

      const closeEmbed = new EmbedBuilder()
        .setTitle('Ticket Closed')
        .setColor(0x888888)
        .setTimestamp()
        .addFields(
          { name: 'Closed by', value: interaction.user.toString(), inline: true },
          { name: 'Reason',    value: reason }
        );

      await interaction.reply({ embeds: [closeEmbed] });
      ticketsData.tickets[ticketId].status = 'closed';
      saveTickets(ticketsData);
    } catch (err) {
      console.error('Error closing ticket:', err);
      return interaction.reply({ content: `Failed to close ticket: ${err.message}`, ephemeral: true });
    }
    try {
      await channel.setLocked(true);
      await channel.setArchived(true);
    } catch (err) {
      console.error('Failed to lock/archive thread:', err);
    }
  }

  if (commandName === 'note') {
    const text = interaction.options.getString('text');
    const noteEmbed = new EmbedBuilder()
      .setTitle('Staff Note')
      .setDescription(text)
      .setColor(0xffa500)
      .setTimestamp()
      .setFooter({ text: `Note by ${interaction.user.tag}` });
    await interaction.reply({ embeds: [noteEmbed] });
  }
});

client.login(TOKEN);
