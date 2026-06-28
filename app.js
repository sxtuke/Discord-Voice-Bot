const { Client, GatewayIntentBits, PermissionsBitField, ChannelType, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, ActivityType, UserSelectMenuBuilder, Events, ContainerBuilder, MessageFlags, Collection } = require("discord.js");
const { joinVoiceChannel } = require("@discordjs/voice");
const fs = require("fs");
const fsPromises = require("fs").promises;

const CONFIG = {
  TOKEN: "Botun tokeni", //Discord Bot Token
  PREFIX: ".",
  GUILD_ID: "Sunucu ID", //Server ID
  OWNER_ID: "Bot Sahibi ID", //Bot Owner
  BOT_VOICE_CHANNEL_ID: "Botu Baglayacagin Kanal",
  
  SETUP: {
    categoryId: "Alttakilerin bulundugu katogeri id", //Create Voice Catogery ID
    panelChannelId: "kontrol panelinin atilacagi kanal id", //Panel Message Channel ID
    createChannelId: "Tıklaninca odayi acicagi kanal id" // Create Voicr Channel ID
  },
  
  ROLES: {
    erkek: "bos birak member rolu koyabilirsin",
    kadin: ""
  },
  // Emojileri kendi zevkine gore ayarla 
  EMOJIS: {
    voice: "",
    users: "",
    lock: "",
    eyes: "",
    crown: "",
    add: ""
  }
};

const lockedAttempts = new Map();
const creatingRooms = new Set();
const buttonCooldowns = new Collection(); 

const DEFAULT_DATA = {
  setup: {
    categoryId: CONFIG.SETUP.categoryId,
    panelChannelId: CONFIG.SETUP.panelChannelId,
    createChannelId: CONFIG.SETUP.createChannelId
  },
  rooms: {}
};

if (!fs.existsSync(DATA_FILE)) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(DEFAULT_DATA, null, 2));
}
let data = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
if (!data.rooms) data.rooms = {};

async function saveData() {
  try {
    await fsPromises.writeFile(DATA_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error("Veri kaydetme hatası:", err);
  }
}

function isOwner(id) {
  return id === CONFIG.OWNER_ID;
}

function joinBotVoice(guild) {
  try {
    const channel = guild.channels.cache.get(CONFIG.BOT_VOICE_CHANNEL_ID);
    if (!channel) return false;

    joinVoiceChannel({
      channelId: CONFIG.BOT_VOICE_CHANNEL_ID,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: true,
      selfMute: false
    });
    return true;
  } catch (err) {
    return false;
  }
}

function getOwnedRoom(member) {
  const voiceChannel = member.voice.channel;
  if (!voiceChannel) return null;
  const room = data.rooms[voiceChannel.id];
  if (!room) return null;
  return { voiceChannel, room };
}

const client = new Client({ intents: [ GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildVoiceStates ]});

client.once(Events.ClientReady, async () => {
  console.log(`${client.user.tag} aktif.`);
  
  client.user.setPresence({
    status: "online", 
    activities: [{
      name: "custom",
      type: ActivityType.Custom,
      state: "#Via." 
    }]
  });

  const guild = client.guilds.cache.get(CONFIG.GUILD_ID);
  if (guild) {
    joinBotVoice(guild);

    let cleaned = 0;
    for (const roomId in data.rooms) {
      if (!guild.channels.cache.has(roomId)) {
        delete data.rooms[roomId];
        cleaned++;
      }
    }
    if (cleaned > 0) {
      console.log(`${cleaned} adet hayalet oda temizlendi.`);
      await saveData();
    }
  }
});

client.on(Events.MessageCreate, async message => {
  if (!message.guild || message.author.bot) return;
  if (message.guild.id !== CONFIG.GUILD_ID) return;
  if (!message.content.startsWith(CONFIG.PREFIX)) return;

  const args = message.content.slice(CONFIG.PREFIX.length).trim().split(/ +/);
  const cmd = args.shift()?.toLowerCase();

  if (cmd === "voicebotr") {
    if (!isOwner(message.author.id)) return;
    joinBotVoice(message.guild);
    message.react("✅").catch(() => {});
    return;
  }

  if (cmd === "panelgonder") {
    if (!isOwner(message.author.id)) return;

    const panelChannel = message.guild.channels.cache.get(CONFIG.SETUP.panelChannelId);
    if (!panelChannel) return message.reply("Panel kanalı bulunamadı.");

    const row1 = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("voice_lock").setEmoji(CONFIG.EMOJIS.lock).setLabel("Kilitle/Aç").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("voice_hide").setEmoji(CONFIG.EMOJIS.eyes).setLabel("Gizle/Göster").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("voice_limit").setEmoji(CONFIG.EMOJIS.users).setLabel("Limit Belirle").setStyle(ButtonStyle.Secondary)
    );

    const row2 = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("voice_add").setEmoji(CONFIG.EMOJIS.add).setLabel("Üye İzni Ver").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("voice_owner").setEmoji(CONFIG.EMOJIS.crown).setLabel("Devret").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("voice_name").setEmoji(CONFIG.EMOJIS.voice).setLabel("İsim Değiş").setStyle(ButtonStyle.Secondary)
    );

    const container = new ContainerBuilder()
      .addTextDisplayComponents(display => 
        display.setContent(`
# ${CONFIG.EMOJIS.voice} Özel Oda Yönetim Paneli
Kendi özel odanızı yönetmek için aşağıdaki butonları kullanabilirsiniz.
Oluşturma kanalına girdiğiniz an odanız otomatik açılır ve sadece size özel olur.

**Güvenlik:**
> Taç sahipleri (Kurucular/Adminler) bile kilitli odaya izinsiz **giremez.** Odayı kilitlediğiniz an içerideki izinsiz herkes atılır.

**Kontroller:**
> ${CONFIG.EMOJIS.lock} **Kilitle / Aç:** Odaya izinsiz girişleri anında engeller.
> ${CONFIG.EMOJIS.eyes} **Gizle / Göster:** Odanızı dışarıdan görünmez yapar.
> ${CONFIG.EMOJIS.users} **Limit:** Odanın maksimum kişi sayısını ayarlar.
> ${CONFIG.EMOJIS.add} **Kullanıcı Ekle:** Kilitli odaya birini davet eder.
> ${CONFIG.EMOJIS.crown} **Sahiplik Devret:** Oda yönetimini başkasına verir.
> ${CONFIG.EMOJIS.voice} **İsim Değiştir:** Odanızın ismini günceller.
        `.trim())
      )
      .addActionRowComponents(row1, row2);

    await panelChannel.send({ components: [container], flags: MessageFlags.IsComponentsV2 });
    message.react("✅").catch(() => {});
  }
});

client.on(Events.InteractionCreate, async interaction => {
  try {
    if (interaction.guildId !== CONFIG.GUILD_ID) return;

    if (interaction.isButton() || interaction.isUserSelectMenu() || interaction.isModalSubmit()) {
      const cdKey = `${interaction.user.id}_${interaction.customId}`;
      if (buttonCooldowns.has(cdKey)) {
        return interaction.reply({ content: "Lütfen işlemleri yavaş yapın (Spam Koruması).", ephemeral: true });
      }
      buttonCooldowns.set(cdKey, true);
      setTimeout(() => buttonCooldowns.delete(cdKey), 3000);
    }

    if (interaction.isButton() && interaction.customId.startsWith("voice_")) {
      const owned = getOwnedRoom(interaction.member);
      if (!owned) return interaction.reply({ content: "Önce kendi özel odanda bulunmalısın.", ephemeral: true });
      if (owned.room.ownerId !== interaction.member.id) return interaction.reply({ content: "Bu odanın sahibi sen değilsin.", ephemeral: true });

      const { voiceChannel, room } = owned;

      if (interaction.customId === "voice_lock") {
        room.locked = !room.locked;
        await saveData();

        if (room.locked) {
          for (const [memberId, channelMember] of voiceChannel.members) {
            if (!channelMember.user.bot && memberId !== room.ownerId && !room.allowed.includes(memberId)) {
           //   await channelMember.voice.disconnect().catch(() => {});
            }
          }
          return interaction.reply({ content: "Odanız **kilitlendi**", ephemeral: true });
        } else {
          return interaction.reply({ content: "Odanızın kilidi **açıldı**.", ephemeral: true });
        }
      }

      if (interaction.customId === "voice_hide") {
        room.hidden = !room.hidden;
        await saveData();

        await voiceChannel.permissionOverwrites.edit(CONFIG.ROLES.erkek, { ViewChannel: !room.hidden }).catch(() => {});
        await voiceChannel.permissionOverwrites.edit(CONFIG.ROLES.kadin, { ViewChannel: !room.hidden }).catch(() => {});

        return interaction.reply({ content: room.hidden ? "Odanız **gizlendi**." : "👁️ Odanız **görünür** yapıldı.", ephemeral: true });
      }

      if (interaction.customId === "voice_limit") {
        const modal = new ModalBuilder().setCustomId("voice_limit_modal").setTitle("Oda Limiti");
        const input = new TextInputBuilder().setCustomId("limit").setLabel("0-99 arası (0 = limitsiz)").setStyle(TextInputStyle.Short).setRequired(true);
        modal.addComponents(new ActionRowBuilder().addComponents(input));
        return interaction.showModal(modal);
      }

      if (interaction.customId === "voice_name") {
        const modal = new ModalBuilder().setCustomId("voice_name_modal").setTitle("Oda İsmi");
        const input = new TextInputBuilder().setCustomId("name").setLabel("Yeni oda ismini girin").setStyle(TextInputStyle.Short).setRequired(true);
        modal.addComponents(new ActionRowBuilder().addComponents(input));
        return interaction.showModal(modal);
      }

      if (interaction.customId === "voice_add") {
        const menu = new UserSelectMenuBuilder().setCustomId("voice_add_select").setPlaceholder("İzin verilecek üyeyi seç").setMinValues(1).setMaxValues(1);
        return interaction.reply({ content: "Odaya eklemek istediğiniz kişiyi seçin:", components: [new ActionRowBuilder().addComponents(menu)], ephemeral: true });
      }

      if (interaction.customId === "voice_owner") {
        const menu = new UserSelectMenuBuilder().setCustomId("voice_owner_select").setPlaceholder("Yeni sahibini seç").setMinValues(1).setMaxValues(1);
        return interaction.reply({ content: "Odayı devretmek istediğiniz kişiyi seçin:", components: [new ActionRowBuilder().addComponents(menu)], ephemeral: true });
      }
    }

    if (interaction.isUserSelectMenu()) {
      const owned = getOwnedRoom(interaction.member);
      if (!owned) return interaction.reply({ content: "❌ Önce kendi özel odanda bulunmalısın.", ephemeral: true });
      
      const { voiceChannel, room } = owned;
      if (room.ownerId !== interaction.member.id) return interaction.reply({ content: "Bu odanın sahibi sen değilsin.", ephemeral: true });

      const selectedId = interaction.values[0];
      const selectedUser = await interaction.client.users.fetch(selectedId).catch(() => null);

      if (selectedUser?.bot) return interaction.reply({ content: "Botlara yetki veremezsiniz.", ephemeral: true });

      if (interaction.customId === "voice_add_select") {
        if (!room.allowed.includes(selectedId)) room.allowed.push(selectedId);
        await saveData();
        await voiceChannel.permissionOverwrites.edit(selectedId, { ViewChannel: true, Connect: true, Speak: true }).catch(() => {});
        return interaction.update({ content: `<@${selectedId}> odanıza başarıyla eklendi.`, components: [] });
      }

      if (interaction.customId === "voice_owner_select") {
        if (selectedId === interaction.user.id) return interaction.reply({ content: "❌ Oda zaten senin.", ephemeral: true });
        room.ownerId = selectedId;
        if (!room.allowed.includes(selectedId)) room.allowed.push(selectedId);
        await saveData();
        await voiceChannel.permissionOverwrites.edit(selectedId, { ViewChannel: true, Connect: true, Speak: true, MoveMembers: true }).catch(() => {});
        return interaction.update({ content: `Oda sahipliği <@${selectedId}> kullanıcısına devredildi.`, components: [] });
      }
    }

    if (interaction.isModalSubmit()) {
      const owned = getOwnedRoom(interaction.member);
      if (!owned) return interaction.reply({ content: "Önce kendi özel odanda bulunmalısın.", ephemeral: true });
      
      const { voiceChannel, room } = owned;
      if (room.ownerId !== interaction.member.id) return interaction.reply({ content: "❌ Bu odanın sahibi sen değilsin.", ephemeral: true });

      if (interaction.customId === "voice_limit_modal") {
        const limit = Number(interaction.fields.getTextInputValue("limit"));
        if (Number.isNaN(limit) || limit < 0 || limit > 99) {
          return interaction.reply({ content: "Lütfen 0-99 arası geçerli bir rakam girin.", ephemeral: true });
        }
        await voiceChannel.setUserLimit(limit).catch(() => {});
        return interaction.reply({ content: `Oda limiti **${limit === 0 ? "Sınırsız" : limit}** olarak ayarlandı.`, ephemeral: true });
      }

      if (interaction.customId === "voice_name_modal") {
        const name = interaction.fields.getTextInputValue("name");
        try {
          await voiceChannel.setName(name);
          return interaction.reply({ content: `Oda ismi **${name}** olarak değiştirildi.`, ephemeral: true });
        } catch (err) {
          if (err.code === 50024) {
            return interaction.reply({ content: "Discord kuralları gereği kanal ismini 10 dakikada sadece 2 kez değiştirebilirsiniz. Lütfen daha sonra tekrar deneyin.", ephemeral: true });
          }
          return interaction.reply({ content: "İsim değiştirilirken bir hata oluştu.", ephemeral: true });
        }
      }
    }
  } catch (err) {
    console.error("Etkileşim Hatası:", err);
  }
});

client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
  const guild = newState.guild || oldState.guild;
  if (!guild || guild.id !== CONFIG.GUILD_ID) return;
  
  if (oldState.id === client.user.id && oldState.channelId && !newState.channelId) {
    setTimeout(() => joinBotVoice(guild), 3000);
    return;
  }

  const member = newState.member || oldState.member;
  if (!member || member.user.bot) return;

  // Oda Açma Kanalına Girme İşlemi
  if (newState.channelId === CONFIG.SETUP.createChannelId) {
    if (creatingRooms.has(member.id)) return;

    const existingRoomId = Object.keys(data.rooms).find(id => data.rooms[id].ownerId === member.id);
    if (existingRoomId) {
      const existingChannel = guild.channels.cache.get(existingRoomId);
      if (existingChannel) {
        await member.voice.setChannel(existingChannel).catch(() => {});
        return;
      } else {
        delete data.rooms[existingRoomId];
        await saveData();
      }
    }

    creatingRooms.add(member.id);

    try {
      const channel = await guild.channels.create({
        name: `${member.user.username}`,
        type: ChannelType.GuildVoice,
        parent: CONFIG.SETUP.categoryId,
        userLimit: 0,
        permissionOverwrites: [
          { id: guild.id, deny: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.Connect, PermissionsBitField.Flags.SendMessages] },
          { id: CONFIG.ROLES.erkek, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.Connect, PermissionsBitField.Flags.Speak], deny: [PermissionsBitField.Flags.SendMessages] },
          { id: CONFIG.ROLES.kadin, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.Connect, PermissionsBitField.Flags.Speak], deny: [PermissionsBitField.Flags.SendMessages] },
          { id: member.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.Connect, PermissionsBitField.Flags.Speak, PermissionsBitField.Flags.MoveMembers], deny: [PermissionsBitField.Flags.SendMessages] },
          { id: client.user.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.Connect, PermissionsBitField.Flags.MoveMembers, PermissionsBitField.Flags.ManageChannels] }
        ]
      });

      // ARTIK VARSAYILAN OLARAK KİLİTSİZ (locked: false)
      data.rooms[channel.id] = { 
        ownerId: member.id, 
        locked: false,
        hidden: false, 
        allowed: [member.id] 
      };
      await saveData();

      await member.voice.setChannel(channel).catch(() => {});
    } catch (err) {
      console.error("Kanal açma hatası:", err);
    } finally {
      creatingRooms.delete(member.id);
    }
    return;
  }

  // Kilitli Odaya İzinsiz Girme Denemeleri
  if (newState.channelId && data.rooms[newState.channelId]) {
    const room = data.rooms[newState.channelId];
    const allowed = room.allowed.includes(member.id);
    const isOwnerRoom = room.ownerId === member.id;

    if (room.locked && !allowed && !isOwnerRoom) {
      await member.voice.disconnect().catch(() => {}); 

      const key = `${newState.channelId}_${member.id}`;
      const now = Date.now();

      if (!lockedAttempts.has(key)) lockedAttempts.set(key, []);
      let attempts = lockedAttempts.get(key);
      
      attempts.push(now);
      attempts = attempts.filter(x => now - x <= 15000);
      lockedAttempts.set(key, attempts);

      if (attempts.length >= 2) {
        member.send("Girmeye çalıştığınız özel oda kilitlidir ve yetkili olsanız dahi izinsiz giremezsiniz.").catch(() => {});
        lockedAttempts.delete(key);
      }
      return;
    }
  }

  // Odadan Çıkma / Devretme veya Silme
  if (oldState.channelId && data.rooms[oldState.channelId]) {
    setTimeout(async () => {
      const channel = guild.channels.cache.get(oldState.channelId);
      if (!channel) return;
    
      if (channel.members.filter(m => !m.user.bot).size === 0) {
        delete data.rooms[channel.id];
        await saveData();
        await channel.delete().catch(() => {});
        return;
      }

      const room = data.rooms[channel.id];
      if (!room) return;

      if (!channel.members.has(room.ownerId)) {
        const newOwner = channel.members.filter(x => !x.user.bot).first();
        if (newOwner) {
          room.ownerId = newOwner.id;
          if (!room.allowed.includes(newOwner.id)) room.allowed.push(newOwner.id);
          await saveData();

          await channel.permissionOverwrites.edit(newOwner.id, {
            ViewChannel: true,
            Connect: true,
            Speak: true,
            MoveMembers: true
          }).catch(() => {});

          try {
             await channel.setName(`${newOwner.user.username}`);
          } catch (err) {
             console.error("Otomatik isim değiştirilirken hata oluştu (Rate Limit olabilir):", err.message);
          }
        }
      }
    }, 1500); 
  }
});

client.on(Events.ChannelDelete, async channel => {
  if (!channel.guild || channel.guild.id !== CONFIG.GUILD_ID) return;
  if (data.rooms[channel.id]) {
    delete data.rooms[channel.id];
    await saveData();
  }
});

process.on("unhandledRejection", (err) => {
  if (err.code !== 10008 && err.code !== 10003) console.error("Yakalanmamış Reddetme:", err);
});
process.on("uncaughtException", (err) => {
  console.error("Beklenmeyen Hata:", err);
});

client.login(CONFIG.TOKEN);
