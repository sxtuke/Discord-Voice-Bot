const { Client, GatewayIntentBits, Partials, ContainerBuilder, TextDisplayBuilder, SeparatorBuilder, SeparatorSpacingSize, ActionRowBuilder, StringSelectMenuBuilder, StringSelectMenuOptionBuilder, MessageFlags, AuditLogEvent, PermissionsBitField, Events} = require("discord.js");
const mongoose = require("mongoose");
const Settings = require("../Settings.json");

const guvenliSchema = new mongoose.Schema({
  guildID:  { type: String, required: true },
  hedefID:  { type: String, required: true },
  tur:      { type: String, enum: ["user", "role"], required: true },
  ekleyen:  { type: String },
  tarih:    { type: Date, default: Date.now },
});

guvenliSchema.index({ guildID: 1, hedefID: 1 }, { unique: true });
const GuvenliModel = mongoose.model("Guvenli", guvenliSchema);
const korumaSchema = new mongoose.Schema({
  guildID: { type: String, required: true, unique: true },
  kickGuard:    { type: Boolean, default: true },
  banGuard:     { type: Boolean, default: true },
  banRemove:    { type: Boolean, default: true },
  botGuard:     { type: Boolean, default: true },
  serverGuard:  { type: Boolean, default: true },
  webhookGuard: { type: Boolean, default: true },
  emojiDelete:  { type: Boolean, default: true },
  emojiCreate:  { type: Boolean, default: true },
  emojiUpdate:  { type: Boolean, default: true },
  channelCreate: { type: Boolean, default: true },
  channelUpdate: { type: Boolean, default: true },
  channelDelete: { type: Boolean, default: true },
  roleMemberUpdate: { type: Boolean, default: true },
  roleCreate:       { type: Boolean, default: true },
  roleUpdate:       { type: Boolean, default: true },
  roleDelete:       { type: Boolean, default: false },
});
const KorumaModel = mongoose.model("Koruma", korumaSchema);

const roleGuardSchema = new mongoose.Schema({
  guildID:          String,
  roleID:           String,
  members:          [String],
  channelOverwrites:[mongoose.Schema.Types.Mixed],
});

const RoleGuardModel = mongoose.model("RoleGuard", roleGuardSchema);
const korumaCache = new Map();

async function korumaGetir(guildID) {
  if (korumaCache.has(guildID)) return korumaCache.get(guildID);
  let doc = await KorumaModel.findOne({ guildID }).lean();
  if (!doc) {
    doc = await KorumaModel.create({ guildID });
    doc = doc.toObject();
  }
  korumaCache.set(guildID, doc);
  return doc;
}

async function korumaDegistir(guildID, alan, deger) {
  const doc = await KorumaModel.findOneAndUpdate(
    { guildID },
    { $set: { [alan]: deger } },
    { new: true, upsert: true, lean: true }
  );
  korumaCache.set(guildID, doc);
  return doc;
}

const guvenliCache = new Map(); 

async function guvenliCacheYukle(guildID) {
  const kayitlar = await GuvenliModel.find({ guildID }).lean();
  guvenliCache.set(guildID, new Set(kayitlar.map(k => k.hedefID)));
}

async function guvenliEkle(guildID, hedefID, tur, ekleyenID) {
  await GuvenliModel.findOneAndUpdate(
    { guildID, hedefID },
    { $set: { tur, ekleyen: ekleyenID, tarih: new Date() } },
    { upsert: true }
  );
  if (!guvenliCache.has(guildID)) guvenliCache.set(guildID, new Set());
  guvenliCache.get(guildID).add(hedefID);
}

async function guvenliKaldir(guildID, hedefID) {
  await GuvenliModel.deleteOne({ guildID, hedefID });
  if (guvenliCache.has(guildID)) guvenliCache.get(guildID).delete(hedefID);
}

const rateTracker = new Map();
const RATE_LIMIT_SURE  = 60_000;
const RATE_LIMIT_LIMIT = 2;

function rateLimitKontrol(guildID, executorID) {
  const anahtar = `${guildID}:${executorID}`;
  const simdi   = Date.now();
  const liste   = (rateTracker.get(anahtar) || []).filter(t => simdi - t < RATE_LIMIT_SURE);
  liste.push(simdi);
  rateTracker.set(anahtar, liste);
  return liste.length >= RATE_LIMIT_LIMIT;
}

setInterval(() => {
  const simdi = Date.now();
  for (const [key, liste] of rateTracker) {
    const temiz = liste.filter(t => simdi - t < RATE_LIMIT_SURE);
    if (temiz.length === 0) rateTracker.delete(key);
    else rateTracker.set(key, temiz);
  }
}, 300_000);

function buildMessage(baslik, aciklama, renk = 0x2b2d31) {
  const container = new ContainerBuilder()
    .setAccentColor(renk)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`### ${baslik}`))
    .addSeparatorComponents(
      new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
    )
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(aciklama));

  return { components: [container], flags: MessageFlags.IsComponentsV2 };
}

async function log(client, logKanalID, guild, baslik, aciklama, renk) {
  try {
    const kanal = client.channels.cache.get(logKanalID)
      || await client.channels.fetch(logKanalID).catch(() => null);
    if (kanal) return kanal.send(buildMessage(baslik, aciklama, renk));
    const owner = await guild.fetchOwner().catch(() => null);
    if (owner) owner.send(buildMessage(baslik, aciklama, renk)).catch(() => {});
  } catch { /* sessizce geç */ }
}

async function guvenliMi(guild, kisiID, botID) {
  if (!guild || !kisiID) return false;
  if (kisiID === botID)               return true;
  if (kisiID === Settings.Server.OwnerID) return true;
  if (kisiID === guild.ownerId)       return true;

  const uye = guild.members.cache.get(kisiID);
  if (!uye) return false;

  if (!guvenliCache.has(guild.id)) await guvenliCacheYukle(guild.id);
  const set = guvenliCache.get(guild.id) || new Set();

  if (set.has(kisiID)) return true;
  for (const rolID of uye.roles.cache.keys()) {
    if (set.has(rolID)) return true;
  }

  return false;
}

async function cezalandir(guild, kisiID, sebep = "Guard Koruma Sistemi") {
  const uye = guild.members.cache.get(kisiID);
  if (!uye) return;
  if (uye.id === guild.ownerId) return;
  if (uye.user.bot && uye.id === guild.members.me?.id) return;
  await uye.kick(sebep).catch(() => {});
}

async function getAuditEntry(guild, tip, maxMs = 5000) {
  try {
    const logs  = await guild.fetchAuditLogs({ type: tip, limit: 1 });
    const entry = logs.entries.first();
    if (!entry || !entry.executor) return null;
    if (Date.now() - entry.createdTimestamp > maxMs) return null;
    return entry;
  } catch {
    return null;
  }
}

async function guardKontrol(opts) {
  const {
    client,
    guild,
    executorID,
    logKanal,
    logBaslik,
    logAciklama,
    logRenk,
    aksiyonFn,
    sebep,
  } = opts;

  const guvenli = await guvenliMi(guild, executorID, client.user.id);
  if (aksiyonFn) await aksiyonFn().catch(() => {});

  if (guvenli) {
    const limitAsildi = rateLimitKontrol(guild.id, executorID);
    if (!limitAsildi) return;

    await cezalandir(guild, executorID, `Guard Rate-Limit: 1 dakikada 2+ işlem`);
    await log(client, logKanal, guild,
      "Güvenli Üye Rate-Limit Aştı",
      `<@${executorID}> (\`${executorID}\`) 1 dakika içinde **2+** işlem yaparak güvenli listesinden bağımsız şekilde **kick** yedi.\n> Sebep: ${sebep}`,
      0xff6b00
    );
    return;
  }

  await cezalandir(guild, executorID, sebep);
  await log(client, logKanal, guild, logBaslik, logAciklama, logRenk);
}

const TEHLIKELI_YETKILER = [
  PermissionsBitField.Flags.Administrator,
  PermissionsBitField.Flags.ManageRoles,
  PermissionsBitField.Flags.ManageChannels,
  PermissionsBitField.Flags.ManageGuild
];

function createClient() {
  return new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildModeration,
      GatewayIntentBits.GuildEmojisAndStickers,
      GatewayIntentBits.GuildWebhooks,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.GuildMember, Partials.User, Partials.Channel],
  });
}

const Guard_1 = createClient();
const Guard_2 = createClient();
const Guard_3 = createClient();

mongoose.connect(Settings.Mongoose.DatabaseUrl)
  .catch(err => console.error("[DB] Bağlantı hatası:", err));
mongoose.connection.once("open", async () => {
  console.log("[DB] MongoDB bağlantısı başarılı.");
});

const KORUMA_TANIMLARI = [
  { alan: "kickGuard",        etiket: "Kick Koruması",           aciklama: "İzinsiz kick atılmasını engeller" },
  { alan: "banGuard",         etiket: "Ban Koruması",            aciklama: "İzinsiz ban atılmasını engeller" },
  { alan: "banRemove",        etiket: "Ban Kaldırma Koruması",   aciklama: "İzinsiz ban kaldırılmasını engeller" },
  { alan: "botGuard",         etiket: "Bot Ekleme Koruması",     aciklama: "İzinsiz bot eklenmesini engeller" },
  { alan: "serverGuard",      etiket: "Sunucu Koruması",         aciklama: "Ad/ikon değişikliğini engeller" },
  { alan: "webhookGuard",     etiket: "Webhook Koruması",        aciklama: "İzinsiz webhook açılmasını engeller" },
  { alan: "emojiDelete",      etiket: "Emoji Silme Koruması",    aciklama: "İzinsiz emoji silinmesini engeller" },
  { alan: "emojiCreate",      etiket: "Emoji Oluşturma Koruması",aciklama: "İzinsiz emoji yüklenmesini engeller" },
  { alan: "emojiUpdate",      etiket: "Emoji Güncelleme Koruması",aciklama: "İzinsiz emoji güncellenmesini engeller" },
  { alan: "channelCreate",    etiket: "Kanal Oluşturma Koruması",aciklama: "İzinsiz kanal açılmasını engeller" },
  { alan: "channelUpdate",    etiket: "Kanal Güncelleme Koruması",aciklama: "İzinsiz kanal düzenlenmesini engeller" },
  { alan: "channelDelete",    etiket: "Kanal Silme Koruması",    aciklama: "İzinsiz kanal silinmesini engeller" },
  { alan: "roleMemberUpdate", etiket: "Sağ Tık Rol Koruması",   aciklama: "Yetkili rol verilmesini engeller" },
  { alan: "roleCreate",       etiket: "Rol Oluşturma Koruması",  aciklama: "İzinsiz rol açılmasını engeller" },
  { alan: "roleUpdate",       etiket: "Rol Güncelleme Koruması", aciklama: "İzinsiz rol düzenlenmesini engeller" },
  { alan: "roleDelete",       etiket: "Rol Silme Koruması",      aciklama: "İzinsiz rol silinmesini engeller (varsayılan KAPALI)" },
];


async function korumaMenusuGonder(message, guildID) {
  const koruma = await korumaGetir(guildID);
  const satirlar = KORUMA_TANIMLARI.map(t => {
    const durum = koruma[t.alan] ? "Açık" : "Kapalı";
    return `${t.etiket} — **${durum}**`;
  }).join("\n");

  const options = KORUMA_TANIMLARI.map(t => {
    const acik = koruma[t.alan];
    return new StringSelectMenuOptionBuilder()
      .setLabel(t.etiket.replace(/^[^ ]+ /, ""))
      .setEmoji(t.etiket.split(" ")[0])
      .setValue(t.alan)
      .setDescription(acik ? "Şu an AÇIK — tıkla KAPAT" : "Şu an KAPALI — tıkla AÇ")
      .setDefault(false);
  });

  const menu = new StringSelectMenuBuilder()
    .setCustomId(`koruma_toggle:${guildID}`)
    .setPlaceholder("🛡️ Açmak/Kapatmak istediğin korumayı seç")
    .addOptions(options)
    .setMinValues(1)
    .setMaxValues(1);

  const row = new ActionRowBuilder().addComponents(menu);
  const container = new ContainerBuilder()
    .setAccentColor(0x5865f2)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent("### 🛡️ Koruma Kontrol Paneli"))
    .addSeparatorComponents(
      new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
    )
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(satirlar));

  await message.channel.send({
    components: [container, row],
    flags: MessageFlags.IsComponentsV2,
  });
}

Guard_1.on("ready", async () => {
  Guard_1.user.setPresence({ activities: [{ name: Settings.Server.Status }], status: "dnd" });
  console.log(`[GUARD 1] ${Guard_1.user.tag} olarak giriş yapıldı.`);
  if (Settings.Server.GuildID) await guvenliCacheYukle(Settings.Server.GuildID).catch(() => {});
});

Guard_1.on(Events.MessageCreate, async message => {
  if (message.author.bot || !message.guild) return;
  if (!message.content.toLowerCase().startsWith(Settings.Prefix.Guard_1P)) return;
  if (
    message.author.id !== Settings.Server.OwnerID &&
    message.author.id !== message.guild.ownerId
  ) return;

  const args    = message.content.slice(Settings.Prefix.Guard_1P.length).trim().split(/\s+/);
  const command = args.shift().toLowerCase();
  const guildID = message.guild.id;

  if (command === "eval" && message.author.id === Settings.Server.OwnerID) {
    if (!args.length) return;
    const code = args.join(" ");
    const clean = t => {
      if (typeof t !== "string") t = require("util").inspect(t, { depth: 0 });
      return t
        .replace(/`/g, "`\u200B")
        .replace(/@/g, "@\u200B")
        .replace(new RegExp(Guard_1.token, "g"), "[TOKEN]");
    };
    try {
      message.channel.send({ content: `\`\`\`js\n${clean(await eval(code))}\n\`\`\`` });
    } catch (err) {
      message.channel.send({ content: `\`\`\`js\n${err}\n\`\`\`` });
    }
    return;
  }

  if (command === "koruma") {
    return korumaMenusuGonder(message, guildID);
  }

  if (command === "güvenliler" || command === "liste") {
    const kayitlar = await GuvenliModel.find({ guildID }).lean();
    if (!kayitlar.length) {
      return message.channel.send(buildMessage("🛡️ Güvenli Liste", "Burası Çok Issız..", 0x5865f2));
    }
    const satirlar = kayitlar.map(k => {
      const rol  = message.guild.roles.cache.get(k.hedefID);
      const uye  = message.guild.members.cache.get(k.hedefID);
      const isim = rol ? `@${rol.name} (rol)` : uye ? `${uye.user.tag} (kullanıcı)` : `\`${k.hedefID}\``;
      return `${isim} — Ekleyen: <@${k.ekleyen || "?"}>`;
    }).join("\n");
    return message.channel.send(buildMessage("🛡️ Güvenli Liste (White List)", satirlar, 0x5865f2));
  }

  if (command === "safe" || command === "güvenli") {
    const rol = message.mentions.roles.first()
      || message.guild.roles.cache.get(args[0])
      || message.guild.roles.cache.find(r => r.name === args.join(" "));
    const uye = message.mentions.users.first()
      || message.guild.members.cache.get(args[0])?.user;
    const hedef = rol || uye;

    if (!hedef) return message.channel.send(
      buildMessage("Hata", "Güvenli listeye eklemek/kaldırmak için `@Kullanıcı/ID` belirtmelisin.", 0xffa500)
    );

    const hedefID = hedef.id;
    const tur     = rol ? "role" : "user";
    const mevcut  = await GuvenliModel.findOne({ guildID, hedefID }).lean();

    if (mevcut) {
      await guvenliKaldir(guildID, hedefID);
      return message.channel.send(
        buildMessage("Güvenli Listeden Çıkarıldı", `${hedef} → ${message.author} tarafından **çıkarıldı**.`, 0xed4245)
      );
    } else {
      await guvenliEkle(guildID, hedefID, tur, message.author.id);
      return message.channel.send(
        buildMessage("Güvenli Listeye Eklendi", `${hedef} → ${message.author} tarafından **eklendi**.`, 0x57f287)
      );
    }
  }
});

Guard_1.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isStringSelectMenu()) return;
  if (!interaction.customId.startsWith("koruma_toggle:")) return;

  if (
    interaction.user.id !== Settings.Server.OwnerID &&
    interaction.user.id !== interaction.guild.ownerId
  ) {
    return interaction.reply({
      ...buildMessage("⛔ Yetki Yok", "Bu menüyü sadece sunucu sahibi kullanabilir.", 0xed4245),
      ephemeral: true,
    });
  }

  const guildID = interaction.customId.split(":")[1];
  const alan    = interaction.values[0];
  const tanim   = KORUMA_TANIMLARI.find(t => t.alan === alan);
  if (!tanim) return interaction.reply({ content: "Bilinmeyen koruma.", ephemeral: true });

  const koruma = await korumaGetir(guildID);
  const yeniDeger = !koruma[alan];
  await korumaDegistir(guildID, alan, yeniDeger);

  const durum = yeniDeger ? "✅ Acik" : "Kapali";
  const renk  = yeniDeger ? 0x57f287 : 0xed4245;

  await interaction.reply({
    ...buildMessage(`🛡️ Koruma ${durum}`, `**${tanim.etiket}** koruması ${durum}.`, renk),
    ephemeral: true,
  });

  const korumaSonrasi = await korumaGetir(guildID);
  const satirlar = KORUMA_TANIMLARI.map(t => {
    const d = korumaSonrasi[t.alan] ? "Açık" : "Kapalı";
    return `${t.etiket} — **${d}**`;
  }).join("\n");

  const options = KORUMA_TANIMLARI.map(t => {
    const acik = korumaSonrasi[t.alan];
    return new StringSelectMenuOptionBuilder()
      .setLabel(t.etiket.replace(/^[^ ]+ /, ""))
      .setEmoji(t.etiket.split(" ")[0])
      .setValue(t.alan)
      .setDescription(acik ? "Şu an AÇIK — tıkla KAPAT" : "Şu an KAPALI — tıkla AÇ")
      .setDefault(false);
  });

  const menu = new StringSelectMenuBuilder()
    .setCustomId(`koruma_toggle:${guildID}`)
    .setPlaceholder("🛡️ Açmak/Kapatmak istediğin korumayı seç")
    .addOptions(options)
    .setMinValues(1)
    .setMaxValues(1);

  const row = new ActionRowBuilder().addComponents(menu);

  const container = new ContainerBuilder()
    .setAccentColor(0x5865f2)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent("### 🛡️ Koruma Kontrol Paneli"))
    .addSeparatorComponents(
      new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
    )
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(satirlar));

  interaction.message.edit({
    components: [container, row],
    flags: MessageFlags.IsComponentsV2,
  }).catch(() => {});
});

Guard_1.on("guildMemberRemove", async member => {
  const koruma = await korumaGetir(member.guild.id);
  if (!koruma.kickGuard) return;
  const entry = await getAuditEntry(member.guild, AuditLogEvent.MemberKick, 5000);
  if (!entry) return;
  await guardKontrol({
    client: Guard_1,
    guild: member.guild,
    executorID: entry.executor.id,
    logKanal: Settings.Log.Guard_Log1,
    logBaslik: "🛡️ Kick Tespit Edildi",
    logAciklama: `${member} (\`${member.id}\`) adlı kullanıcıya <@${entry.executor.id}> tarafından **Kick** atıldı.`,
    logRenk: 0xed4245,
    sebep: "Guard | İzinsiz Kick",
  });
});

Guard_1.on("guildBanAdd", async ban => {
  const koruma = await korumaGetir(ban.guild.id);
  if (!koruma.banGuard) return;
  const entry = await getAuditEntry(ban.guild, AuditLogEvent.MemberBanAdd, 5000);
  if (!entry) return;
  await guardKontrol({
    client: Guard_1,
    guild: ban.guild,
    executorID: entry.executor.id,
    logKanal: Settings.Log.Guard_Log1,
    logBaslik: "🛡️ İzinsiz Ban Tespit Edildi",
    logAciklama: `<@${ban.user.id}> adlı kullanıcıya <@${entry.executor.id}> tarafından **Ban** atıldı, ban açıldı.`,
    logRenk: 0xed4245,
    aksiyonFn: () => ban.guild.members.unban(ban.user.id, "İzinsiz Ban — Koruma Sistemi"),
    sebep: "Guard | İzinsiz Ban",
  });
});

Guard_1.on("guildMemberAdd", async member => {
  const koruma = await korumaGetir(member.guild.id);
  if (!koruma.botGuard || !member.user.bot) return;
  const entry = await getAuditEntry(member.guild, AuditLogEvent.BotAdd, 5000);
  if (!entry) return;
  await guardKontrol({
    client: Guard_1,
    guild: member.guild,
    executorID: entry.executor.id,
    logKanal: Settings.Log.Guard_Log1,
    logBaslik: "🛡️ İzinsiz Bot Eklendi",
    logAciklama: `${member} (\`${member.id}\`) adlı bot <@${entry.executor.id}> tarafından **eklendi**.`,
    logRenk: 0xed4245,
    aksiyonFn: () => member.ban({ reason: "Guard | İzinsiz Bot" }),
    sebep: "Guard | İzinsiz Bot Ekleme",
  });
});


Guard_1.on("guildUpdate", async (oldGuild, newGuild) => {
  if (oldGuild.vanityURLCode !== newGuild.vanityURLCode) {
    const entry = await getAuditEntry(newGuild, AuditLogEvent.GuildUpdate, 5000);
    if (entry && entry.executor.id !== Guard_1.user.id) {
      await guardKontrol({
        client: Guard_1,
        guild: newGuild,
        executorID: entry.executor.id,
        logKanal: Settings.Log.Guard_Log1,
        logBaslik: "🔐 Vanity URL Değiştirme Girişimi",
        logAciklama: `<@${entry.executor.id}> sunucunun **${Settings.Server.VanityURL}** adresini değiştirmeye çalıştı.`,
        logRenk: 0xffa500,
        aksiyonFn: () => fetch(`https://discord.com/api/v10/guilds/${newGuild.id}/vanity-url`, {
          method: "PATCH",
          headers: { Authorization: `Bot ${Settings.Token.Guard_1}`, "Content-Type": "application/json" },
          body: JSON.stringify({ code: Settings.Server.VanityURL }),
        }),
        sebep: "Guard | Vanity URL Değiştirme",
      });
      return;
    }
  }

  const koruma = await korumaGetir(newGuild.id);
  if (!koruma.serverGuard) return;
  const entry = await getAuditEntry(newGuild, AuditLogEvent.GuildUpdate, 3000);
  if (!entry) return;
  await guardKontrol({
    client: Guard_1,
    guild: newGuild,
    executorID: entry.executor.id,
    logKanal: Settings.Log.Guard_Log1,
    logBaslik: "🛡️ Sunucu Ayarları Değiştirildi",
    logAciklama: `<@${entry.executor.id}> tarafından **Sunucu Ayarları** güncellendi, geri alındı.`,
    logRenk: 0xffa500,
    aksiyonFn: async () => {
      if (newGuild.name !== oldGuild.name) await newGuild.setName(oldGuild.name).catch(() => {});
      if (newGuild.iconURL({ size: 2048 }) !== oldGuild.iconURL({ size: 2048 }))
        await newGuild.setIcon(oldGuild.iconURL({ size: 2048 })).catch(() => {});
    },
    sebep: "Guard | İzinsiz Sunucu Güncelleme",
  });
});

Guard_1.on("webhookUpdate", async channel => {
  const koruma = await korumaGetir(channel.guild.id);
  if (!koruma.webhookGuard) return;
  const entry = await getAuditEntry(channel.guild, AuditLogEvent.WebhookCreate, 10000);
  if (!entry) return;
  const webhooks = await channel.fetchWebhooks().catch(() => null);
  await guardKontrol({
    client: Guard_1,
    guild: channel.guild,
    executorID: entry.executor.id,
    logKanal: Settings.Log.Guard_Log1,
    logBaslik: "🛡️ İzinsiz Webhook Açıldı",
    logAciklama: `<@${entry.executor.id}> tarafından **Webhook** oluşturuldu, silindi.`,
    logRenk: 0xed4245,
    aksiyonFn: () => {
      if (webhooks) webhooks.forEach(w => w.delete("Guard | Webhook Koruması").catch(() => {}));
      return Promise.resolve();
    },
    sebep: "Guard | İzinsiz Webhook",
  });
});

Guard_1.on("emojiDelete", async emoji => {
  const koruma = await korumaGetir(emoji.guild.id);
  if (!koruma.emojiDelete) return;
  const entry = await getAuditEntry(emoji.guild, AuditLogEvent.EmojiDelete, 10000);
  if (!entry) return;
  await guardKontrol({
    client: Guard_1,
    guild: emoji.guild,
    executorID: entry.executor.id,
    logKanal: Settings.Log.Guard_Log1,
    logBaslik: "🛡️ Emoji Silindi",
    logAciklama: `<@${entry.executor.id}> tarafından **${emoji.name}** emojisi silindi, geri yüklendi.`,
    logRenk: 0xffa500,
    aksiyonFn: () => emoji.guild.emojis.create({ attachment: emoji.imageURL(), name: emoji.name }),
    sebep: "Guard | İzinsiz Emoji Silme",
  });
});

Guard_1.on("emojiCreate", async emoji => {
  const koruma = await korumaGetir(emoji.guild.id);
  if (!koruma.emojiCreate) return;
  const entry = await getAuditEntry(emoji.guild, AuditLogEvent.EmojiCreate, 10000);
  if (!entry) return;
  await guardKontrol({
    client: Guard_1,
    guild: emoji.guild,
    executorID: entry.executor.id,
    logKanal: Settings.Log.Guard_Log1,
    logBaslik: "🛡️ İzinsiz Emoji Yüklendi",
    logAciklama: `<@${entry.executor.id}> tarafından **${emoji.name}** emojisi yüklendi, silindi.`,
    logRenk: 0xffa500,
    aksiyonFn: () => emoji.delete("Guard | Emoji Koruması"),
    sebep: "Guard | İzinsiz Emoji Oluşturma",
  });
});

Guard_1.on("emojiUpdate", async (oldEmoji, newEmoji) => {
  if (oldEmoji.name === newEmoji.name) return;
  const koruma = await korumaGetir(oldEmoji.guild.id);
  if (!koruma.emojiUpdate) return;
  const entry = await getAuditEntry(oldEmoji.guild, AuditLogEvent.EmojiUpdate, 10000);
  if (!entry) return;
  await guardKontrol({
    client: Guard_1,
    guild: oldEmoji.guild,
    executorID: entry.executor.id,
    logKanal: Settings.Log.Guard_Log1,
    logBaslik: "🛡️ Emoji Güncellendi",
    logAciklama: `<@${entry.executor.id}> tarafından **${oldEmoji.name}** emojisi güncellendi, geri alındı.`,
    logRenk: 0xffa500,
    aksiyonFn: () => newEmoji.setName(oldEmoji.name),
    sebep: "Guard | İzinsiz Emoji Güncelleme",
  });
});

Guard_1.on("guildBanRemove", async ban => {
  const koruma = await korumaGetir(ban.guild.id);
  if (!koruma.banRemove) return;
  const entry = await getAuditEntry(ban.guild, AuditLogEvent.MemberBanRemove, 5000);
  if (!entry) return;
  await guardKontrol({
    client: Guard_1,
    guild: ban.guild,
    executorID: entry.executor.id,
    logKanal: Settings.Log.Guard_Log1,
    logBaslik: "🛡️ İzinsiz Ban Kaldırıldı",
    logAciklama: `<@${entry.executor.id}> birisinin **Banını** izinsiz kaldırdı.`,
    logRenk: 0xed4245,
    aksiyonFn: () => ban.guild.members.ban(ban.user.id, { reason: "Banı Kaldırıldı — Tekrar Atıldı" }),
    sebep: "Guard | İzinsiz Ban Kaldırma",
  });
});

Guard_2.on("ready", () => {
  Guard_2.user.setPresence({ activities: [{ name: Settings.Server.Status }], status: "dnd" });
  console.log(`[GUARD 2] ${Guard_2.user.tag} olarak giriş yapıldı.`);
});

Guard_2.on(Events.MessageCreate, async message => {
  if (message.author.bot || !message.guild) return;
  if (!message.content.toLowerCase().startsWith(Settings.Prefix.Guard_2P)) return;
  if (
    message.author.id !== Settings.Server.OwnerID &&
    message.author.id !== message.guild.ownerId
  ) return;

  const args    = message.content.slice(Settings.Prefix.Guard_2P.length).trim().split(/\s+/);
  const command = args.shift().toLowerCase();

  if (command === "eval" && message.author.id === Settings.Server.OwnerID) {
    if (!args.length) return;
    const code = args.join(" ");
    const clean = t => {
      if (typeof t !== "string") t = require("util").inspect(t, { depth: 0 });
      return t.replace(/`/g, "`\u200B").replace(/@/g, "@\u200B").replace(new RegExp(Guard_2.token, "g"), "[TOKEN]");
    };
    try {
      message.channel.send({ content: `\`\`\`js\n${clean(await eval(code))}\n\`\`\`` });
    } catch (err) {
      message.channel.send({ content: `\`\`\`js\n${err}\n\`\`\`` });
    }
  }
});

Guard_2.on("channelCreate", async channel => {
  const koruma = await korumaGetir(channel.guild.id);
  if (!koruma.channelCreate) return;
  const entry = await getAuditEntry(channel.guild, AuditLogEvent.ChannelCreate, 3000);
  if (!entry) return;
  await guardKontrol({
    client: Guard_2,
    guild: channel.guild,
    executorID: entry.executor.id,
    logKanal: Settings.Log.Guard_Log2,
    logBaslik: "🛡️ İzinsiz Kanal Oluşturuldu",
    logAciklama: `<@${entry.executor.id}> tarafından yeni bir **Kanal** oluşturuldu, silindi.`,
    logRenk: 0xed4245,
    aksiyonFn: () => channel.delete("Guard | Kanal Açma Koruması"),
    sebep: "Guard | İzinsiz Kanal Oluşturma",
  });
});

Guard_2.on("channelUpdate", async (oldChannel, newChannel) => {
  const koruma = await korumaGetir(newChannel.guild.id);
  if (!koruma.channelUpdate) return;
  const entry = await getAuditEntry(newChannel.guild, AuditLogEvent.ChannelUpdate, 3000);
  if (!entry || !newChannel.guild.channels.cache.has(newChannel.id)) return;
  await guardKontrol({
    client: Guard_2,
    guild: newChannel.guild,
    executorID: entry.executor.id,
    logKanal: Settings.Log.Guard_Log2,
    logBaslik: "🛡️ Kanal Güncellendi",
    logAciklama: `<@${entry.executor.id}> tarafından **${oldChannel.name}** kanalı güncellendi, geri alındı.`,
    logRenk: 0xffa500,
    aksiyonFn: async () => {
      if (newChannel.parentId !== oldChannel.parentId && newChannel.type !== 4)
        await newChannel.setParent(oldChannel.parentId).catch(() => {});
      const duzeltme = { name: oldChannel.name };
      if (newChannel.isTextBased()) Object.assign(duzeltme, {
        topic: oldChannel.topic, nsfw: oldChannel.nsfw, rateLimitPerUser: oldChannel.rateLimitPerUser,
      });
      else if (newChannel.isVoiceBased()) Object.assign(duzeltme, {
        bitrate: oldChannel.bitrate, userLimit: oldChannel.userLimit,
      });
      await newChannel.edit(duzeltme).catch(() => {});
      oldChannel.permissionOverwrites.cache.forEach(perm => {
        const izinler = {};
        perm.allow.toArray().forEach(p => { izinler[p] = true; });
        perm.deny.toArray().forEach(p => { izinler[p] = false; });
        newChannel.permissionOverwrites.edit(perm.id, izinler).catch(() => {});
      });
    },
    sebep: "Guard | İzinsiz Kanal Güncelleme",
  });
});

Guard_2.on("channelDelete", async channel => {
  const koruma = await korumaGetir(channel.guild.id);
  if (!koruma.channelDelete) return;
  const entry = await getAuditEntry(channel.guild, AuditLogEvent.ChannelDelete, 3000);
  if (!entry) return;
  await guardKontrol({
    client: Guard_2,
    guild: channel.guild,
    executorID: entry.executor.id,
    logKanal: Settings.Log.Guard_Log2,
    logBaslik: "🛡️ Kanal Silindi",
    logAciklama: `<@${entry.executor.id}> tarafından **${channel.name}** kanalı silindi, yeniden oluşturuldu.`,
    logRenk: 0xed4245,
    aksiyonFn: async () => {
      const yeniKanal = await channel.clone({ reason: "Guard | Kanal Silme Koruması" }).catch(() => null);
      if (!yeniKanal) return;
      if (channel.parentId) await yeniKanal.setParent(channel.parentId).catch(() => {});
      await yeniKanal.setPosition(channel.position).catch(() => {});
      if (channel.type === 4) {
        channel.guild.channels.cache
          .filter(k => k.parentId === channel.id)
          .forEach(x => x.setParent(yeniKanal.id).catch(() => {}));
      }
    },
    sebep: "Guard | İzinsiz Kanal Silme",
  });
});

Guard_2.on("guildUpdate", async (oldGuild, newGuild) => {
  if (oldGuild.vanityURLCode === newGuild.vanityURLCode) return;
  const entry = await getAuditEntry(newGuild, AuditLogEvent.GuildUpdate, 5000);
  if (!entry || entry.executor.id === Guard_2.user.id) return;
  await guardKontrol({
    client: Guard_2,
    guild: newGuild,
    executorID: entry.executor.id,
    logKanal: Settings.Log.Guard_Log2,
    logBaslik: "🔐 Vanity URL Değiştirme Girişimi",
    logAciklama: `<@${entry.executor.id}> sunucunun **${Settings.Server.VanityURL}** adresini değiştirmeye çalıştı.`,
    logRenk: 0xffa500,
    aksiyonFn: () => fetch(`https://discord.com/api/v10/guilds/${newGuild.id}/vanity-url`, {
      method: "PATCH",
      headers: { Authorization: `Bot ${Settings.Token.Guard_2}`, "Content-Type": "application/json" },
      body: JSON.stringify({ code: Settings.Server.VanityURL }),
    }),
    sebep: "Guard | Vanity URL Değiştirme",
  });
});

Guard_3.on("ready", () => {
  Guard_3.user.setPresence({ activities: [{ name: Settings.Server.Status }], status: "dnd" });
  console.log(`[GUARD 3] ${Guard_3.user.tag} olarak giriş yapıldı.`);
});

Guard_3.on(Events.MessageCreate, async message => {
  if (message.author.bot || !message.guild) return;
  if (!message.content.toLowerCase().startsWith(Settings.Prefix.Guard_3P)) return;
  if (
    message.author.id !== Settings.Server.OwnerID &&
    message.author.id !== message.guild.ownerId
  ) return;

  const args    = message.content.slice(Settings.Prefix.Guard_3P.length).trim().split(/\s+/);
  const command = args.shift().toLowerCase();

  if (command === "eval" && message.author.id === Settings.Server.OwnerID) {
    if (!args.length) return;
    const code = args.join(" ");
    const clean = t => {
      if (typeof t !== "string") t = require("util").inspect(t, { depth: 0 });
      return t.replace(/`/g, "`\u200B").replace(/@/g, "@\u200B").replace(new RegExp(Guard_3.token, "g"), "[TOKEN]");
    };
    try {
      message.channel.send({ content: `\`\`\`js\n${clean(await eval(code))}\n\`\`\`` });
    } catch (err) {
      message.channel.send({ content: `\`\`\`js\n${err}\n\`\`\`` });
    }
  }
});

Guard_3.on("guildMemberUpdate", async (oldMember, newMember) => {
  const koruma = await korumaGetir(newMember.guild.id);
  if (!koruma.roleMemberUpdate) return;
  if (newMember.roles.cache.size <= oldMember.roles.cache.size) return;
  const entry = await getAuditEntry(newMember.guild, AuditLogEvent.MemberRoleUpdate, 5000);
  if (!entry) return;
  const tehlikeliRolVerildi = TEHLIKELI_YETKILER.some(
    p => !oldMember.permissions.has(p) && newMember.permissions.has(p)
  );
  if (!tehlikeliRolVerildi) return;
  await guardKontrol({
    client: Guard_3,
    guild: newMember.guild,
    executorID: entry.executor.id,
    logKanal: Settings.Log.Guard_Log3,
    logBaslik: "🛡️ İzinsiz Sağ Tık Rol",
    logAciklama: `${newMember} adlı kullanıcıya <@${entry.executor.id}> tarafından **yetkili rol** verildi, geri alındı.`,
    logRenk: 0xed4245,
    aksiyonFn: () => newMember.roles.set(oldMember.roles.cache.map(r => r.id)),
    sebep: "Guard | İzinsiz Yetkili Rol Verme",
  });
});

Guard_3.on("roleCreate", async role => {
  const koruma = await korumaGetir(role.guild.id);
  if (!koruma.roleCreate) return;
  const entry = await getAuditEntry(role.guild, AuditLogEvent.RoleCreate, 5000);
  if (!entry) return;
  await guardKontrol({
    client: Guard_3,
    guild: role.guild,
    executorID: entry.executor.id,
    logKanal: Settings.Log.Guard_Log3,
    logBaslik: "⛔ İzinsiz Rol Oluşturuldu",
    logAciklama: `<@${entry.executor.id}> tarafından **Rol** oluşturuldu, silindi.`,
    logRenk: 0xed4245,
    aksiyonFn: () => role.delete("Guard | Rol Açma Koruması"),
    sebep: "Guard | İzinsiz Rol Oluşturma",
  });
});


Guard_3.on("roleUpdate", async (oldRole, newRole) => {
  const koruma = await korumaGetir(newRole.guild.id);
  if (!koruma.roleUpdate) return;
  const entry = await getAuditEntry(newRole.guild, AuditLogEvent.RoleUpdate, 3000);
  if (!entry || !newRole.guild.roles.cache.has(newRole.id)) return;
  const tehlikeliIzinEklendi = TEHLIKELI_YETKILER.some(
    p => !oldRole.permissions.has(p) && newRole.permissions.has(p)
  );
  await guardKontrol({
    client: Guard_3,
    guild: newRole.guild,
    executorID: entry.executor.id,
    logKanal: Settings.Log.Guard_Log3,
    logBaslik: "⛔ Rol Güncellendi",
    logAciklama: `<@${entry.executor.id}> tarafından **${oldRole.name}** rolü güncellendi, geri alındı.`,
    logRenk: 0xffa500,
    aksiyonFn: async () => {
      if (tehlikeliIzinEklendi) {
        newRole.guild.roles.cache
          .filter(r => !r.managed && (
            r.permissions.has(PermissionsBitField.Flags.Administrator) ||
            r.permissions.has(PermissionsBitField.Flags.ManageRoles) ||
            r.permissions.has(PermissionsBitField.Flags.ManageGuild)
          ))
          .forEach(r => r.setPermissions(36818497n).catch(() => {}));
      }
      await newRole.edit({
        name: oldRole.name, color: oldRole.color, hoist: oldRole.hoist,
        permissions: oldRole.permissions, mentionable: oldRole.mentionable,
      }).catch(() => {});
    },
    sebep: "Guard | İzinsiz Rol Güncelleme",
  });
});

Guard_3.on("roleDelete", async role => {
  const koruma = await korumaGetir(role.guild.id);
  if (!koruma.roleDelete) return;
  const entry = await getAuditEntry(role.guild, AuditLogEvent.RoleDelete, 5000);
  if (!entry) return;
  await guardKontrol({
    client: Guard_3,
    guild: role.guild,
    executorID: entry.executor.id,
    logKanal: Settings.Log.Guard_Log3,
    logBaslik: "⛔ Rol Silindi",
    logAciklama: `<@${entry.executor.id}> tarafından **${role.name}** (\`${role.id}\`) rolü silindi, yeniden oluşturuldu.`,
    logRenk: 0xed4245,
    aksiyonFn: async () => {
      const yeniRol = await role.guild.roles.create({
        name: role.name, color: role.color, hoist: role.hoist,
        position: role.position, permissions: role.permissions, mentionable: role.mentionable,
        reason: "Guard | Silinen Rol Yeniden Oluşturuldu",
      }).catch(() => null);
      if (!yeniRol) return;
      const roleData = await RoleGuardModel.findOne({ guildID: role.guild.id, roleID: role.id }).lean();
      if (!roleData) return;
      setTimeout(() => {
        (roleData.channelOverwrites || []).forEach((perm, i) => {
          const kanal = role.guild.channels.cache.get(perm.id);
          if (!kanal) return;
          setTimeout(() => {
            const izinler = {};
            perm.allow.forEach(p => { izinler[p] = true; });
            perm.deny.forEach(p => { izinler[p] = false; });
            kanal.permissionOverwrites.edit(yeniRol, izinler).catch(() => {});
          }, i * 5000);
        });
      }, 5000);
      (roleData.members || []).forEach((memberID, i) => {
        setTimeout(() => {
          const uye = role.guild.members.cache.get(memberID);
          if (uye && !uye.roles.cache.has(yeniRol.id)) uye.roles.add(yeniRol.id).catch(() => {});
        }, i * 3000);
      });
    },
    sebep: "Guard | İzinsiz Rol Silme",
  });
});

function hataYonetimi(client, ad) {
  client.on("warn",       m => console.warn(`[${ad}][WARN] ${m}`));
  client.on("error",      e => console.error(`[${ad}][ERROR] ${e}`));
  client.on("shardError", e => console.error(`[${ad}][SHARD] ${e}`));
}

hataYonetimi(Guard_1, "GUARD 1");
hataYonetimi(Guard_2, "GUARD 2");
hataYonetimi(Guard_3, "GUARD 3");

process.on("uncaughtException",  err => console.error("[PROCESS][ERROR]",  err));
process.on("unhandledRejection", err => console.error("[PROCESS][REJECT]", err));

Guard_1.login(Settings.Token.Guard_1).then(() => console.log("[GUARD 1] Başarıyla giriş yapıldı!")).catch(err => console.error("[GUARD 1] Giriş hatası:", err));
Guard_2.login(Settings.Token.Guard_2).then(() => console.log("[GUARD 2] Başarıyla giriş yapıldı!")).catch(err => console.error("[GUARD 2] Giriş hatası:", err));
Guard_3.login(Settings.Token.Guard_3).then(() => console.log("[GUARD 3] Başarıyla giriş yapıldı!")).catch(err => console.error("[GUARD 3] Giriş hatası:", err));
