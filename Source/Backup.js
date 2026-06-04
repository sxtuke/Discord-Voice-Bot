const AYARLAR = {
  TOKENS: {
    'Ana Bot':   'TOKEN_1_BURAYA',
    'Yedek Bot': 'TOKEN_2_BURAYA',
  },
  GUILD_ID:            'GUILD_ID_BURAYA',
  OWNER_ID:            'OWNER_ID_BURAYA',
  PREFIX:              '!',
  DB_URL:              'mongodb://localhost:27017/rolebackup',
  LOG_CHANNEL:         'backup-log',
  STATUS:              '🛡️',
  VOICE_ID:            '',
  BACKUP_INTERVAL_MS:  1000 * 60 * 15, // 15 Dakikada bir yedekleme
  ROLE_DELETE_DELAY_MS: 1000 * 10,
};

const { Client, GatewayIntentBits, Partials, PermissionFlagsBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, StringSelectMenuOptionBuilder, Events, ActivityType } = require('discord.js');
const { joinVoiceChannel } = require('@discordjs/voice');
const mongoose = require('mongoose');

// --- ŞEMALAR ---
const roleSchema = new mongoose.Schema({
  _id:               mongoose.Schema.Types.ObjectId,
  guildID:           { type: String, required: true },
  roleID:            { type: String, required: true },
  name:              String,
  color:             String,
  hoist:             Boolean,
  position:          Number,
  permissions:       String,
  mentionable:       Boolean,
  time:              Number,
  members:           { type: Array, default: [] },
  channelOverwrites: { type: Array, default: [] },
  deletedAt:         { type: Number, default: null },
  restored:          { type: Boolean, default: false },
});
const RoleDB = mongoose.models.Roles || mongoose.model('Roles', roleSchema);

const webSchema = new mongoose.Schema({
  guildID: { type: String, required: true },
  userID:  { type: String, required: true },
  roles:   { type: Array, default: [] },
});
const WebDB = mongoose.models.Web || mongoose.model('Web', webSchema);

const silmeKuyruguSchema = new mongoose.Schema({
  guildID:   { type: String, required: true },
  roleID:    { type: String, required: true },
  silinmeZamani: { type: Number, required: true },
  islendi:   { type: Boolean, default: false },
});
const SilmeKuyrugu = mongoose.models.SilmeKuyrugu || mongoose.model('SilmeKuyrugu', silmeKuyruguSchema);

// --- FONKSİYONLAR ---

// Embed yerine Markdown içerikli Message Component yapısı
async function logGonder(client, opts = {}) {
  const {
    title   = '',
    desc    = '',
    fields  = [],
    buttons = [],
    content = '',
  } = opts;

  const guild = client.guilds.cache.get(AYARLAR.GUILD_ID);
  if (!guild) return null;
  const ch = guild.channels.cache.find(c => c.name === AYARLAR.LOG_CHANNEL);
  if (!ch) return null;

  let mesajMetni = content ? `${content}\n` : '';
  if (title) mesajMetni += `### ${title}\n`;
  if (desc)  mesajMetni += `> ${desc.split('\n').join('\n> ')}\n\n`;

  if (fields.length) {
    fields.forEach(f => {
      mesajMetni += `- **${f.name}:** ${f.value}\n`;
    });
  }

  const rows = [];
  for (let i = 0; i < Math.min(buttons.length, 25); i += 5) {
    const row = new ActionRowBuilder().addComponents(
      buttons.slice(i, i + 5).map(b => {
        const btn = new ButtonBuilder()
          .setLabel(b.label)
          .setCustomId(b.id)
          .setStyle(b.style ?? ButtonStyle.Secondary);
        if (b.emoji)    btn.setEmoji(b.emoji);
        if (b.disabled) btn.setDisabled(true);
        return btn;
      })
    );
    rows.push(row);
  }

  try {
    return await ch.send({
      content: mesajMetni.trim(),
      allowedMentions: { parse: content.includes('@here') || content.includes('@everyone') ? ['everyone'] : [] },
      components: rows,
    });
  } catch (e) {
    console.error('[LOG] Gönderilemedi:', e.message);
    return null;
  }
}

async function rolKur(client, guild, roleData, tetikleyenKullanici, baslangicIndex = 0) {
  let yeniRol;

  if (baslangicIndex === 0) {
    const mevcutRol = guild.roles.cache.find(r => r.name === roleData.name);
    if (mevcutRol) {
      await logGonder(client, {
        title: '⚠️ Rol Zaten Var',
        desc:  `**${roleData.name}** sunucuda zaten mevcut: <@&${mevcutRol.id}>\nÜye dağıtımına devam ediliyor...`,
      });
      yeniRol = mevcutRol;
    } else {
      try {
        yeniRol = await guild.roles.create({
          name:        roleData.name,
          color:       roleData.color,
          hoist:       roleData.hoist,
          permissions: BigInt(roleData.permissions ?? '0'),
          position:    roleData.position,
          mentionable: roleData.mentionable,
          reason:      '🛡️ Rol yedeği kurulumu',
        });
      } catch (err) {
        console.error('[KUR] Rol oluşturulamadı:', err.message);
        await logGonder(client, {
          title:   '❌ Rol Oluşturulamadı',
          desc:    `**${roleData.name}** \`${roleData.roleID}\` oluşturulurken hata.\n\`${err.message}\``,
          content: '@here',
          buttons: [{
            label: '🔁 Tekrar Dene',
            id:    `kur_${roleData.roleID}`,
            style: ButtonStyle.Danger,
            emoji: '🔁',
          }],
        });
        return null;
      }

      await logGonder(client, {
        title:  '✅ Rol Oluşturuldu',
        desc:   `**${yeniRol.name}** <@&${yeniRol.id}> oluşturuldu. Kanal izinleri ve üyeler işleniyor...`,
        fields: [
          { name: 'Tetikleyen',  value: `<@${tetikleyenKullanici}>` },
          { name: 'Hedef Üye Sayısı', value: `${roleData.members?.length ?? 0}` },
        ],
      });
    }

    const kanalOverwrites = roleData.channelOverwrites ?? [];
    for (let i = 0; i < kanalOverwrites.length; i++) {
      const perm  = kanalOverwrites[i];
      const kanal = guild.channels.cache.get(perm.id);
      if (!kanal) continue;

      await new Promise(r => setTimeout(r, i === 0 ? 3000 : 5000));

      const permObj = {};
      (perm.allow ?? []).forEach(p => { permObj[p] = true;  });
      (perm.deny  ?? []).forEach(p => { permObj[p] = false; });

      try {
        await kanal.permissionOverwrites.create(yeniRol, permObj);
      } catch (err) {
        console.warn(`[KUR] Kanal izni yazılamadı ${kanal.name}:`, err.message);
        await logGonder(client, {
          title:   '⚠️ Kanal İzni Yazılamadı',
          desc:    `**#${kanal.name}** kanalına <@&${yeniRol.id}> izni eklenemedi.\n\`${err.message}\``,
          buttons: [{
            label: '🔁 Tekrar Dene',
            id:    `kanalfixle_${yeniRol.id}__${kanal.id}`,
            style: ButtonStyle.Primary,
          }],
        });
      }
    }
  } else {
    yeniRol = guild.roles.cache.find(r => r.name === roleData.name);
    if (!yeniRol) return null;
  }

  const uyeler = (roleData.members ?? []).slice(baslangicIndex);
  let basariSayisi = 0;
  let hataSayisi   = 0;

  for (let i = 0; i < uyeler.length; i++) {
    const uye = guild.members.cache.get(uyeler[i]);
    if (!uye || uye.roles.cache.has(yeniRol.id)) continue;

    await new Promise(r => setTimeout(r, i === 0 ? 1000 : 3000));

    try {
      await uye.roles.add(yeniRol.id, '🛡️ Rol yedeği dağıtımı');
      basariSayisi++;
    } catch (err) {
      hataSayisi++;
      console.warn(`[KUR] Üyeye rol verilemedi ${uye.user.tag}:`, err.message);

      if (hataSayisi >= 5) {
        const gercekIndex = baslangicIndex + i;
        await logGonder(client, {
          title:   '🔴 Dağıtım Takıldı',
          desc:    `**${yeniRol.name}** dağıtımı çok fazla hata aldı.\n${basariSayisi} üye başarılı, ${hataSayisi}+ hata.\nDüzeltmek için butona bas.`,
          content: '@here',
          buttons: [{
            label: '🔁 Dağıtımı Sürdür',
            id:    `dagitimsurdur_${yeniRol.id}__${gercekIndex}`,
            style: ButtonStyle.Danger,
          }],
          fields: [{ name: 'Kalan Üye', value: `${uyeler.length - i}` }],
        });
        return yeniRol;
      }
    }
  }

  await logGonder(client, {
    title:  '🎉 Kurulum Tamamlandı',
    desc:   `**${yeniRol.name}** <@&${yeniRol.id}> kurulumu ve dağıtımı tamamen bitti.`,
    fields: [
      { name: '✅ Başarılı', value: `${basariSayisi}` },
      { name: '❌ Hatalı',   value: `${hataSayisi}` },
      { name: 'Kanal İzni Yazılan', value: `${roleData.channelOverwrites?.length ?? 0}` },
    ],
  });

  await RoleDB.findOneAndUpdate(
    { guildID: AYARLAR.GUILD_ID, roleID: roleData.roleID },
    { $set: { restored: true, deletedAt: null } }
  ).catch(() => {});

  return yeniRol;
}

// 15 Dakikalık Otomatik Yedekleme Döngüsü
async function setRoleBackup(client) {
  const guild = client.guilds.cache.get(AYARLAR.GUILD_ID);
  if (!guild) return;

  await guild.members.fetch().catch(() => {});
  console.log('[BACKUP] 15 Dakikalık Yedekleme Başladı...');

  const roller = guild.roles.cache.filter(r => r.name !== '@everyone' && !r.managed);

  for (const [, role] of roller) {
    const kanalPerms = [];
    guild.channels.cache
      .filter(c => c.permissionOverwrites?.cache?.has(role.id))
      .forEach(c => {
        const ow = c.permissionOverwrites.cache.get(role.id);
        kanalPerms.push({
          id:    c.id,
          allow: ow.allow.toArray(),
          deny:  ow.deny.toArray(),
        });
      });

    const veri = {
      guildID:           AYARLAR.GUILD_ID,
      roleID:            role.id,
      name:              role.name,
      color:             role.hexColor,
      hoist:             role.hoist,
      position:          role.rawPosition,
      permissions:       role.permissions.bitfield.toString(),
      mentionable:       role.mentionable,
      time:              Date.now(),
      members:           role.members.map(m => m.id),
      channelOverwrites: kanalPerms,
      deletedAt:         null,
      restored:          false,
    };

    try {
      const mevcut = await RoleDB.findOne({ roleID: role.id });
      if (!mevcut) {
        await new RoleDB({ _id: new mongoose.Types.ObjectId(), ...veri }).save();
      } else {
        Object.assign(mevcut, veri);
        await mevcut.save();
      }
    } catch (e) {
      console.error('[BACKUP] Kayıt hatası:', e.message);
    }
  }

  const tumKayitlar = await RoleDB.find({ guildID: AYARLAR.GUILD_ID });
  const silinenler  = tumKayitlar.filter(r =>
    !guild.roles.cache.has(r.roleID) &&
    Date.now() - r.time > 1000 * 60 * 60 * 24 * 3 && // 3 Günden eski silinenler
    !r.restored
  );

  // 15 Dakikada Bir Gidecek Detaylı Log
  await logGonder(client, {
    title: '🕒 Sistem Yedeklemesi Tamamlandı',
    desc:  'Tüm sunucu rolleri ve ayarları güncel olarak veritabanına kaydedildi.',
    fields: [
      { name: 'Kayıt Altına Alınan Rol', value: `${roller.size} adet` },
      { name: 'Silindiği Tespit Edilen', value: `${silinenler.length} adet` },
      { name: 'Tarih', value: `<t:${Math.floor(Date.now() / 1000)}:f>` }
    ]
  });

  if (silinenler.length) {
    const butonlar = silinenler.slice(0, 25).map(r => ({
      label: `🛠️ ${r.name.slice(0, 18)}`,
      id:    `kur_${r.roleID}`,
      style: ButtonStyle.Danger,
    }));

    await logGonder(client, {
      title:   '🗑️ Silinen Roller Tespit Edildi',
      desc:    `${silinenler.length} rol yedekte var ama sunucuda mevcut değil.\nAşağıdaki butonlardan manuel kurtarma yapabilirsiniz.`,
      content: '@here',
      fields:  silinenler.slice(0, 10).map((r, i) => ({
        name:   `${i + 1}. ${r.name}`,
        value:  `ID: \`${r.roleID}\``,
      })),
      buttons: butonlar,
    });
  }

  console.log(`[BACKUP] Tamamlandı. ${roller.size} rol yedeği tazelendi.`);
}

// --- BOT OLUŞTURUCU ---
const botlar = new Map();

function createBot(isim, token) {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildPresences,
      GatewayIntentBits.GuildVoiceStates,
    ],
    partials: [Partials.Message, Partials.Channel, Partials.GuildMember],
  });

  client.on(Events.ClientReady, async () => {
    console.log(`[BOT] ${isim} (${client.user.tag}) hazır.`);
    client.user.setPresence({
      activities: [{ name: AYARLAR.STATUS, type: ActivityType.Watching }],
      status: 'dnd',
    });

    const guild = client.guilds.cache.get(AYARLAR.GUILD_ID);
    if (guild) await guild.members.fetch().catch(() => {});

    if (AYARLAR.VOICE_ID) {
      const ch = client.channels.cache.get(AYARLAR.VOICE_ID);
      if (ch?.isVoiceBased()) {
        joinVoiceChannel({
          channelId:      ch.id,
          guildId:        ch.guild.id,
          adapterCreator: ch.guild.voiceAdapterCreator,
          selfDeaf:       true,
          selfMute:       true,
        });
      }
    }
  });

  client.on(Events.GuildRoleDelete, async role => {
    if (role.guild.id !== AYARLAR.GUILD_ID) return;
    if (role.name === '@everyone' || role.managed) return;

    const mevcut = await RoleDB.findOne({ guildID: AYARLAR.GUILD_ID, roleID: role.id });
    if (!mevcut) return;

    await RoleDB.findOneAndUpdate(
      { guildID: AYARLAR.GUILD_ID, roleID: role.id },
      { $set: { deletedAt: Date.now(), restored: false } }
    );

    await SilmeKuyrugu.create({
      guildID:       AYARLAR.GUILD_ID,
      roleID:        role.id,
      silinmeZamani: Date.now(),
      islendi:       false,
    });

    await logGonder(client, {
      title:   '⚠️ Rol Silindi — Otomatik Kurtarma Bekleniyor',
      desc:    `**${role.name}** (\`${role.id}\`) silindi.\n🕐 **${AYARLAR.ROLE_DELETE_DELAY_MS / 1000} saniye** içerisinde işlem otomatik tetiklenecek.`,
      content: '@here',
      fields: [
        { name: 'Eski Üye Sayısı',  value: `${mevcut.members?.length ?? 0}` },
        { name: 'Kanal İzni', value: `${mevcut.channelOverwrites?.length ?? 0}` },
        { name: 'Son Yedek Alınma',  value: `<t:${Math.floor(mevcut.time / 1000)}:R>` },
      ],
      buttons: [
        { label: '⏹️ OTO-KUR İPTAL ET', id: `otokuriptal_${role.id}`, style: ButtonStyle.Danger },
        { label: '🚀 ŞİMDİ KUR',        id: `kur_${role.id}`,         style: ButtonStyle.Success },
      ],
    });

    setTimeout(async () => {
      const kuyruk = await SilmeKuyrugu.findOne({ guildID: AYARLAR.GUILD_ID, roleID: role.id, islendi: false });
      if (!kuyruk) return; // İptal edilmiş

      await SilmeKuyrugu.findByIdAndUpdate(kuyruk._id, { $set: { islendi: true } });

      const roleData = await RoleDB.findOne({ guildID: AYARLAR.GUILD_ID, roleID: role.id });
      if (!roleData) return;

      const hedefGuild = client.guilds.cache.get(AYARLAR.GUILD_ID);
      if (!hedefGuild) return;

      await rolKur(client, hedefGuild, roleData, client.user.id);
    }, AYARLAR.ROLE_DELETE_DELAY_MS);
  });

  client.on(Events.GuildRoleUpdate, async (eskiRol, yeniRol) => {
    if (yeniRol.guild.id !== AYARLAR.GUILD_ID) return;
    if (yeniRol.name === '@everyone' || yeniRol.managed) return;

    const kanalPerms = [];
    yeniRol.guild.channels.cache
      .filter(c => c.permissionOverwrites?.cache?.has(yeniRol.id))
      .forEach(c => {
        const ow = c.permissionOverwrites.cache.get(yeniRol.id);
        kanalPerms.push({
          id:    c.id,
          allow: ow.allow.toArray(),
          deny:  ow.deny.toArray(),
        });
      });

    const guncelleme = {
      name:              yeniRol.name,
      color:             yeniRol.hexColor,
      hoist:             yeniRol.hoist,
      position:          yeniRol.rawPosition,
      permissions:       yeniRol.permissions.bitfield.toString(),
      mentionable:       yeniRol.mentionable,
      time:              Date.now(),
      members:           yeniRol.members.map(m => m.id),
      channelOverwrites: kanalPerms,
    };

    try {
      const mevcut = await RoleDB.findOne({ guildID: AYARLAR.GUILD_ID, roleID: yeniRol.id });
      if (!mevcut) {
        await new RoleDB({ _id: new mongoose.Types.ObjectId(), guildID: AYARLAR.GUILD_ID, roleID: yeniRol.id, ...guncelleme }).save();
      } else {
        Object.assign(mevcut, guncelleme);
        await mevcut.save();
      }
    } catch (e) {
      console.error('[ROL GÜNCELLE] Hata:', e.message);
    }
  });

  client.on(Events.GuildMemberAdd, async member => {
    if (member.guild.id !== AYARLAR.GUILD_ID) return;

    const tumRolKayitlari = await RoleDB.find({ guildID: AYARLAR.GUILD_ID });
    const uyeninRolleri   = tumRolKayitlari.filter(r => r.members?.includes(member.id));

    if (!uyeninRolleri.length) return;

    for (const rolVeri of uyeninRolleri) {
      const gercekRol = member.guild.roles.cache.get(rolVeri.roleID);
      if (!gercekRol) continue;
      await member.roles.add(gercekRol.id, '🛡️ Yeniden katılan üye — yedekten rol iade edildi').catch(() => {});
      await new Promise(r => setTimeout(r, 500));
    }

    await logGonder(client, {
      title: '🔄 Çık-Gir Yapan Üye',
      desc: `${member.toString()} sunucuya yeniden katıldı. Veritabanındaki eski rolleri tespit edilip geri verildi.`,
      fields: [
        { name: 'Kullanıcı', value: `${member.user.tag} (\`${member.id}\`)` },
        { name: 'İade Edilen Roller', value: uyeninRolleri.map(r => r.name).join(', ') || 'Yok' }
      ]
    });
  });

  client.on(Events.MessageCreate, async message => {
    if (message.author.bot || !message.guild) return;
    if (!message.content.toLowerCase().startsWith(AYARLAR.PREFIX)) return;
    if (message.author.id !== AYARLAR.OWNER_ID && message.author.id !== message.guild.ownerId) return;

    const args    = message.content.split(' ').slice(1);
    const command = message.content.split(' ')[0].slice(AYARLAR.PREFIX.length).toLowerCase();

    if (command === 'eval' && message.author.id === AYARLAR.OWNER_ID) {
      if (!args[0]) return message.reply('Kodu belirt.');
      const code = args.join(' ');
      try {
        let sonuc = await eval(code);
        if (typeof sonuc !== 'string') sonuc = require('util').inspect(sonuc, { depth: 1 });
        sonuc = sonuc.replace(new RegExp(token, 'g'), '[TOKEN GİZLENDİ]');
        message.reply({ content: `\`\`\`js\n${sonuc.slice(0, 1900)}\n\`\`\`` });
      } catch (e) {
        message.reply({ content: `\`\`\`js\n${e.message}\n\`\`\`` });
      }
    }

    if (command === 'restart') {
      await message.reply('🔄 Sistem yeniden başlatılıyor...');
      process.exit(0);
    }

    if (['kur', 'kurulum', 'backup', 'setup'].includes(command)) {
      if (!args[0] || isNaN(args[0])) {
        return message.reply('Geçerli bir **Rol ID** belirtmelisin. Kullanım: `!kur <roleID>`');
      }

      const roleID   = args[0];
      const roleData = await RoleDB.findOne({ guildID: AYARLAR.GUILD_ID, roleID });
      if (!roleData) {
        return message.reply(`❌ \`${roleID}\` için veritabanında kayıtlı bir yedek bulunamadı.`);
      }

      const botSecenekleri = [...botlar.keys()].map(n =>
        new StringSelectMenuOptionBuilder()
          .setLabel(n)
          .setValue(`botseç:${n}:${roleID}:${message.author.id}`)
          .setDescription(`${n} altyapısı üzerinden kurulum yap`)
      );

      const selectRow = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`botseçmenu_${roleID}`)
          .setPlaceholder('Dağıtım Yapacak Botu Seçin')
          .addOptions(botSecenekleri)
      );

      // Embed yerine markdown metin
      const text = `### 🤖 Kurulum: ${roleData.name}\n` +
                   `> Bu rolü sunucuda tekrar kurmak ve dağıtmak için aşağıdaki menüden işlem yapacak botu seç.\n\n` +
                   `- **Hedef Üye:** ${roleData.members?.length ?? 0}\n` +
                   `- **Kanal İzinleri:** ${roleData.channelOverwrites?.length ?? 0}\n` +
                   `- **Yedek Tarihi:** <t:${Math.floor(roleData.time / 1000)}:f>`;

      await message.reply({ content: text, components: [selectRow] });
    }

    if (command === 'liste' || command === 'list') {
      const tumRoller = await RoleDB.find({ guildID: AYARLAR.GUILD_ID });
      if (!tumRoller.length) return message.reply('Kayıtlı yedek rol bulunmuyor.');

      let text = `### 📋 Veritabanındaki Roller (${tumRoller.length} Adet)\n\n`;
      tumRoller.slice(0, 20).forEach((r, i) => {
        text += `${i + 1}. **${r.name}** \`${r.roleID}\` — ${r.members?.length ?? 0} Üye ${r.deletedAt ? '🗑️' : ''}\n`;
      });

      const row = new ActionRowBuilder().addComponents(
        tumRoller.slice(0, 5).map(r =>
          new ButtonBuilder()
            .setLabel(`🛠️ ${r.name.slice(0, 16)}`)
            .setCustomId(`kur_${r.roleID}`)
            .setStyle(ButtonStyle.Primary)
        )
      );

      message.reply({ content: text, components: tumRoller.length > 0 ? [row] : [] });
    }

    if (command === 'yedekle' || command === 'savebackup') {
      await message.reply('🔄 Manuel yedekleme tetiklendi, başlatılıyor...');
      await setRoleBackup(client);
    }

    if (command === 'temizle') {
      const roleID = args[0];
      if (!roleID) return message.reply('Kullanım: `!temizle <roleID>`');
      const sonuc = await RoleDB.findOneAndDelete({ guildID: AYARLAR.GUILD_ID, roleID });
      if (!sonuc) return message.reply('❌ Sistemde böyle bir rol ID kaydı yok.');
      message.reply(`✅ \`${roleID}\` ID'li rolün yedeği kalıcı olarak silindi.`);
    }
  });

  client.on(Events.InteractionCreate, async interaction => {
    const guild = interaction.guild;

    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('botseçmenu_')) {
      const [, botIsmi, roleID, orijinalKullanici] = interaction.values[0].split(':');
      if (interaction.user.id !== orijinalKullanici) {
        return interaction.reply({ content: '🚫 Bu menüyü kullanan kişi sen değilsin.', ephemeral: true });
      }

      const seciliBot = botlar.get(botIsmi);
      if (!seciliBot) {
        return interaction.reply({ content: `❌ **${botIsmi}** anlık olarak erişilemez durumda.`, ephemeral: true });
      }

      await interaction.update({
        content: `### 🚀 Onay Bekleniyor\n> **${botIsmi}** adlı botu seçtin. Kuruluma başlamak için butona tıkla.`,
        components: [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(`kuryap_${botIsmi}__${roleID}__${orijinalKullanici}`)
              .setLabel(`🛠️ Kurulumu Başlat`)
              .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
              .setCustomId(`kuriptal_${roleID}`)
              .setLabel('İşlemi İptal Et')
              .setStyle(ButtonStyle.Secondary)
          ),
        ],
      });
    }

    if (interaction.isButton() && interaction.customId.startsWith('kuryap_')) {
      const parca = interaction.customId.replace('kuryap_', '');
      const [botIsmi, roleID, orijinalKullanici] = parca.split('__');

      if (interaction.user.id !== orijinalKullanici && interaction.user.id !== AYARLAR.OWNER_ID && interaction.user.id !== guild?.ownerId) {
        return interaction.reply({ content: '🚫 Bu işlem için yetkin yok!', ephemeral: true });
      }

      await interaction.deferReply({ ephemeral: true });

      const roleData = await RoleDB.findOne({ guildID: AYARLAR.GUILD_ID, roleID });
      if (!roleData) return interaction.editReply('❌ Rol veritabanından çekilemedi.');

      const kullanilacakBot = botlar.get(botIsmi) ?? client;
      const hedefGuild      = kullanilacakBot.guilds.cache.get(AYARLAR.GUILD_ID);

      await interaction.editReply(`⏳ **${roleData.name}** kurulumu sunucuda başlatılıyor... Log kanalını kontrol edin.`);
      await rolKur(kullanilacakBot, hedefGuild, roleData, interaction.user.id);
    }

    if (interaction.isButton() && interaction.customId.startsWith('kur_')) {
      const roleID = interaction.customId.replace('kur_', '');

      if (interaction.user.id !== AYARLAR.OWNER_ID && interaction.user.id !== guild?.ownerId) {
        return interaction.reply({ content: '🚫 Sadece sunucu sahipleri rol kurabilir.', ephemeral: true });
      }

      await interaction.deferReply({ ephemeral: true });

      const roleData = await RoleDB.findOne({ guildID: AYARLAR.GUILD_ID, roleID });
      if (!roleData) return interaction.editReply('❌ İlgili yedek veritabanında yok.');

      if (botlar.size > 1) {
        const secenekler = [...botlar.keys()].map(n =>
          new StringSelectMenuOptionBuilder()
            .setLabel(n)
            .setValue(`botseç:${n}:${roleID}:${interaction.user.id}`)
        );
        const row = new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId(`botseçmenu_${roleID}`)
            .setPlaceholder('İşlemi gerçekleştirecek botu seçin.')
            .addOptions(secenekler)
        );
        return interaction.editReply({ content: '### 🤖 Çoklu Bot Sistemi\n> Lütfen rol kurulumu yapacak botu listeden seçin.', components: [row] });
      }

      await interaction.editReply(`⏳ **${roleData.name}** kurulumu başladı.`);
      await rolKur(client, guild, roleData, interaction.user.id);
    }

    if (interaction.isButton() && interaction.customId.startsWith('otokuriptal_')) {
      const roleID = interaction.customId.replace('otokuriptal_', '');

      if (interaction.user.id !== AYARLAR.OWNER_ID && interaction.user.id !== guild?.ownerId) {
        return interaction.reply({ content: '🚫 Yetkisiz işlem.', ephemeral: true });
      }

      await SilmeKuyrugu.findOneAndUpdate(
        { guildID: AYARLAR.GUILD_ID, roleID, islendi: false },
        { $set: { islendi: true } }
      );

      await interaction.update({
        content: `❌ **Oto-Kurulum Durduruldu.** Rol geri kurulmayacak.\nİsterseniz daha sonra \`!kur ${roleID}\` yazarak manuel çağırabilirsiniz.`,
        components: [],
      });
    }

    if (interaction.isButton() && interaction.customId.startsWith('kuriptal_')) {
      await interaction.update({ content: '❌ Kurulum işlemi kullanıcı tarafından iptal edildi.', components: [] });
    }

    if (interaction.isButton() && interaction.customId.startsWith('kanalfixle_')) {
      const parcalar = interaction.customId.replace('kanalfixle_', '').split('__');
      const rolId    = parcalar[0];
      const kanalId  = parcalar[1];

      if (interaction.user.id !== AYARLAR.OWNER_ID && interaction.user.id !== guild?.ownerId) {
        return interaction.reply({ content: 'Yetkiniz bulunmuyor.', ephemeral: true });
      }

      await interaction.deferReply({ ephemeral: true });

      const roleData  = await RoleDB.findOne({ guildID: AYARLAR.GUILD_ID, roleID: rolId });
      if (!roleData) return interaction.editReply('Rol verisine ulaşılamadı.');

      const kanal    = guild.channels.cache.get(kanalId);
      const rol      = guild.roles.cache.get(rolId) ?? guild.roles.cache.find(r => r.name === roleData.name);
      const permVeri = roleData.channelOverwrites?.find(p => p.id === kanalId);

      if (!kanal || !rol || !permVeri) return interaction.editReply('Bağlantı bulunamadı (Kanal/Rol/İzin silinmiş).');

      const permObj = {};
      (permVeri.allow ?? []).forEach(p => { permObj[p] = true;  });
      (permVeri.deny  ?? []).forEach(p => { permObj[p] = false; });

      try {
        await kanal.permissionOverwrites.create(rol, permObj);
        await interaction.editReply(`✅ **#${kanal.name}** kanalına ait senkronizasyon tamamlandı.`);
      } catch (e) {
        await interaction.editReply(`Hata devam ediyor: ${e.message}`);
      }
    }

    if (interaction.isButton() && interaction.customId.startsWith('dagitimsurdur_')) {
      const parca    = interaction.customId.replace('dagitimsurdur_', '').split('__');
      const rolId    = parca[0];
      const startIdx = parseInt(parca[1] ?? '0');

      if (interaction.user.id !== AYARLAR.OWNER_ID && interaction.user.id !== guild?.ownerId) {
        return interaction.reply({ content: '🚫 Yetkiniz yok.', ephemeral: true });
      }

      await interaction.deferReply({ ephemeral: true });

      const roleData = await RoleDB.findOne({ guildID: AYARLAR.GUILD_ID, roleID: rolId });
      if (!roleData) return interaction.editReply('Veri bulunamadı.');

      const rol = guild.roles.cache.get(rolId) ?? guild.roles.cache.find(r => r.name === roleData.name);
      if (!rol) return interaction.editReply('Rol fiziksel olarak yok, önce rolü açın.');

      const kalanUyeler = (roleData.members ?? []).slice(startIdx);
      let basari = 0, hata = 0;

      for (let i = 0; i < kalanUyeler.length; i++) {
        const uye = guild.members.cache.get(kalanUyeler[i]);
        if (!uye || uye.roles.cache.has(rol.id)) continue;
        await new Promise(r => setTimeout(r, i === 0 ? 500 : 3000));
        try   { await uye.roles.add(rol.id, 'Dağıtım Sürdürme'); basari++; }
        catch { hata++; }
      }

      await logGonder(client, {
        title:  '✅ Manuel Dağıtım Bitti',
        desc:   `**${rol.name}** için yarıda kalan işlem bitirildi.`,
        fields: [
          { name: 'Kayıpsız Atanan', value: `${basari}` },
          { name: 'Hata', value: `${hata}` },
        ],
      });
      await interaction.editReply(`İşlem sonlandı: ✅ ${basari} üye, ❌ ${hata} hata.`);
    }
  });

  client.on(Events.PresenceUpdate, async (eski, yeni) => {
    if (!yeni.member || yeni.user?.bot) return;
    if (yeni.guild?.id !== AYARLAR.GUILD_ID) return;
    if (yeni.user?.id === AYARLAR.OWNER_ID) return;

    const GID    = AYARLAR.GUILD_ID;
    const uye    = yeni.member;
    const status = yeni.clientStatus ?? {};
    const webAcik = 'web' in status;

    const yetkiliRoller = uye.roles.cache.filter(r =>
      r.editable && r.name !== '@everyone' &&
      [
        PermissionFlagsBits.Administrator,
        PermissionFlagsBits.BanMembers,
        PermissionFlagsBits.KickMembers,
        PermissionFlagsBits.ManageGuild,
        PermissionFlagsBits.ManageMessages,
        PermissionFlagsBits.ManageRoles,
        PermissionFlagsBits.MentionEveryone,
      ].some(p => r.permissions.has(p))
    );

    const yetkiVarMi = [
      PermissionFlagsBits.Administrator,
      PermissionFlagsBits.BanMembers,
      PermissionFlagsBits.KickMembers,
      PermissionFlagsBits.ManageGuild,
      PermissionFlagsBits.ManageMessages,
      PermissionFlagsBits.ManageRoles,
      PermissionFlagsBits.MentionEveryone,
    ].some(p => uye.permissions.has(p));

    if (!yetkiVarMi) return;

    if (webAcik) {
      const zatenVarMi = await WebDB.findOne({ guildID: GID, userID: yeni.user.id });
      if (zatenVarMi) return;

      await WebDB.findOneAndUpdate(
        { guildID: GID, userID: yeni.user.id },
        { $set: { roles: yetkiliRoller.map(r => r.id) } },
        { upsert: true }
      );
      await uye.roles.remove(yetkiliRoller.map(r => r.id), '🌐 Sekme açma şüphesi — roller alındı').catch(() => {});

      await logGonder(client, {
        title: '⚠️ Sekme Şüphesi (Web Girişi)',
        desc: `${yeni.user.toString()} hesabına Web üzerinden giriş yapıldığı tespit edildiği için yetkileri geçici olarak alındı.`,
        content: '@everyone',
        fields: [{ name: 'Çekilen Yetkiler', value: yetkiliRoller.map(r => `<@&${r.id}>`).join(', ') || 'Yok' }]
      });

    } else {
      const db = await WebDB.findOne({ guildID: GID, userID: yeni.user.id });
      if (!db?.roles?.length) return;

      for (const rolId of db.roles) {
        await uye.roles.add(rolId, 'Sekme kapatıldı — roller iade edildi').catch(() => {});
        await new Promise(r => setTimeout(r, 500));
      }

      await WebDB.findOneAndDelete({ guildID: GID, userID: yeni.user.id });

      await logGonder(client, {
        title: '✅ Şüpheli Durum Kalktı',
        desc: `${yeni.user.toString()} kullanıcısının Web bağlantısı kesildi. Roller tekrar teslim edildi.`,
        fields: [{ name: 'Teslim Edilen Yetkiler', value: db.roles.map(r => `<@&${r}>`).join(', ') || 'Yok' }]
      });
    }
  });

  client.on('warn',  m => console.warn(`[${isim}][WARN]`,  m));
  client.on('error', e => console.error(`[${isim}][ERROR]`, e.message));

  return client;
}

async function main() {
  await mongoose.connect(AYARLAR.DB_URL);
  console.log('[DB] MongoDB sunucusuna başarılı şekilde bağlanıldı.');

  for (const [isim, token] of Object.entries(AYARLAR.TOKENS)) {
    const bot = createBot(isim, token);
    botlar.set(isim, bot);
    await bot.login(token)
      .then(() => console.log(`[LOGIN] ${isim} platforma giriş yaptı.`))
      .catch(e  => console.error(`[LOGIN] ${isim} bağlantı hatası:`, e.message));
  }

  const [anaBot] = botlar.values();

  // 15 Dakikada Bir Yedekleme Interval'i
  setInterval(() => setRoleBackup(anaBot), AYARLAR.BACKUP_INTERVAL_MS);
  
  // Bot açıldığında ilk yedeği almak için
  setTimeout(()  => setRoleBackup(anaBot), 5000);
}

process.on('uncaughtException',  e => console.error('[HATA/BÜYÜK]', e));
process.on('unhandledRejection', e => console.error('[HATA/VAAT]', e));

main().catch(console.error);
