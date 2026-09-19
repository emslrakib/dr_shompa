IF NOT EXISTS (SELECT * FROM sys.databases WHERE name = 'DrShompaDB')
BEGIN
    CREATE DATABASE DrShompaDB;
END
GO

USE DrShompaDB;
GO

-- 1. Appointments Table
IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[dbo].[Appointments]') AND type in (N'U'))
BEGIN
    CREATE TABLE Appointments (
        Id INT IDENTITY(1,1) PRIMARY KEY,
        PatientName NVARCHAR(150) NOT NULL,
        Age INT NOT NULL,
        Phone NVARCHAR(30) NOT NULL,
        VisitType NVARCHAR(50) NOT NULL,
        PreferredDate DATE NOT NULL,
        PreferredSlot NVARCHAR(50) NOT NULL,
        Notes NVARCHAR(MAX) NULL,
        Status NVARCHAR(30) NOT NULL DEFAULT 'Pending',
        CreatedAt DATETIME NOT NULL DEFAULT GETDATE()
    );
END
GO

-- 2. SiteSettings Table (Key-Value storage)
IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[dbo].[SiteSettings]') AND type in (N'U'))
BEGIN
    CREATE TABLE SiteSettings (
        SettingKey NVARCHAR(100) PRIMARY KEY,
        SettingValue NVARCHAR(MAX) NOT NULL,
        UpdatedAt DATETIME NOT NULL DEFAULT GETDATE()
    );
END
GO

-- Seed default SiteSettings if empty or missing image keys
IF NOT EXISTS (SELECT 1 FROM SiteSettings WHERE SettingKey = 'doctor_name')
BEGIN
    INSERT INTO SiteSettings (SettingKey, SettingValue) VALUES
    ('doctor_name', 'Dr. Arefin Zannat Sompa'),
    ('doctor_title', 'Consultant Psychiatrist — Department of Psychiatry, Sylhet MAG Osmani Medical College'),
    ('location_kicker', 'SYLHET, BANGLADESH'),
    ('lede_text', 'Assessment and treatment for depression, anxiety, sleep difficulty, and other mental health conditions — for adults and adolescents, in a calm and confidential setting.'),
    ('degree_1', 'MD | Psychiatry, BMU'),
    ('degree_2', 'BCS | Health cadre'),
    ('degree_3', 'SOMC | Teaching hospital'),
    ('phone', '01339059043'),
    ('email', 'sompa.szmc@gmail.com'),
    ('chamber_address', 'Sylhet, Bangladesh (Near Sylhet MAG Osmani Medical College)'),
    ('chamber_hours', 'Sat–Thu, evening chamber hours'),
    ('email_hint', 'Replies within two working days'),
    ('maps_url', 'https://maps.google.com/?q=Sylhet+MAG+Osmani+Medical+College'),
    ('doctor_photo', 'dr_sompa_portrait.jpg'),
    ('chamber_photo', 'clinic_ambience.jpg'),
    ('wellness_photo', 'mental_wellness_care.jpg'),
    ('site_logo', '');
END
GO

-- Seed image settings if missing in existing database
IF NOT EXISTS (SELECT 1 FROM SiteSettings WHERE SettingKey = 'doctor_photo')
    INSERT INTO SiteSettings (SettingKey, SettingValue) VALUES ('doctor_photo', 'dr_sompa_portrait.jpg');
IF NOT EXISTS (SELECT 1 FROM SiteSettings WHERE SettingKey = 'chamber_photo')
    INSERT INTO SiteSettings (SettingKey, SettingValue) VALUES ('chamber_photo', 'clinic_ambience.jpg');
IF NOT EXISTS (SELECT 1 FROM SiteSettings WHERE SettingKey = 'wellness_photo')
    INSERT INTO SiteSettings (SettingKey, SettingValue) VALUES ('wellness_photo', 'mental_wellness_care.jpg');
IF NOT EXISTS (SELECT 1 FROM SiteSettings WHERE SettingKey = 'site_logo')
    INSERT INTO SiteSettings (SettingKey, SettingValue) VALUES ('site_logo', '');
GO

-- 3. Services Table
IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[dbo].[Services]') AND type in (N'U'))
BEGIN
    CREATE TABLE Services (
        Id INT IDENTITY(1,1) PRIMARY KEY,
        Title NVARCHAR(150) NOT NULL,
        Description NVARCHAR(MAX) NOT NULL,
        SortOrder INT NOT NULL DEFAULT 0,
        IsActive BIT NOT NULL DEFAULT 1
    );

    INSERT INTO Services (Title, Description, SortOrder) VALUES
    ('Depression & mood', 'Low mood, loss of interest, bipolar disorder, and postpartum depression.', 1),
    ('Anxiety & panic', 'Generalised anxiety, panic attacks, phobia, and obsessive-compulsive disorder.', 2),
    ('Sleep problems', 'Insomnia, disturbed sleep cycles, and sleep difficulty linked to stress.', 3),
    ('Adolescent mental health', 'Exam stress, behavioural change, and school or family difficulty in teenagers.', 4),
    ('Psychotic illness', 'Schizophrenia and related conditions, with long-term follow-up and family guidance.', 5),
    ('Addiction support', 'Substance use assessment, withdrawal management, and relapse prevention planning.', 6);
END
GO

-- 4. Testimonials Table
IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[dbo].[Testimonials]') AND type in (N'U'))
BEGIN
    CREATE TABLE Testimonials (
        Id INT IDENTITY(1,1) PRIMARY KEY,
        Quote NVARCHAR(MAX) NOT NULL,
        Author NVARCHAR(150) NOT NULL,
        SortOrder INT NOT NULL DEFAULT 0,
        IsActive BIT NOT NULL DEFAULT 1
    );

    INSERT INTO Testimonials (Quote, Author, SortOrder) VALUES
    ('She explained my diagnosis in words my family could follow. For the first time we understood what was happening.', 'PATIENT''S DAUGHTER, SYLHET', 1),
    ('No rush, no judgement. She asked questions nobody had asked me before, and the treatment plan actually made sense.', 'PATIENT, 34', 2),
    ('My son refused to see a doctor for months. After one session with her, he agreed to continue treatment.', 'PARENT, MOULVIBAZAR', 3);
END
GO

-- 5. Qualifications Table
IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[dbo].[Qualifications]') AND type in (N'U'))
BEGIN
    CREATE TABLE Qualifications (
        Id INT IDENTITY(1,1) PRIMARY KEY,
        Title NVARCHAR(150) NOT NULL,
        Description NVARCHAR(MAX) NOT NULL,
        Subtext NVARCHAR(150) NOT NULL,
        SortOrder INT NOT NULL DEFAULT 0
    );

    INSERT INTO Qualifications (Title, Description, Subtext, SortOrder) VALUES
    ('Qualifications', 'MBBS, BCS (Health), MD in Psychiatry.', 'Bangladesh Medical University', 1),
    ('Current position', 'Department of Psychiatry, Sylhet MAG Osmani Medical College (SOMC).', 'Sylhet, Bangladesh', 2),
    ('Care philosophy', 'Listening first, explaining clearly, and treating each person with dignity.', 'Empathy. Expertise. Excellence.', 3);
END
GO
